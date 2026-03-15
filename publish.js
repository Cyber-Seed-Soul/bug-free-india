const fs = require('fs');
const path = require('path');
const matter = require('gray-matter');
const FormData = require('form-data'); // Re-enabled for strict boundary generation

const STRAPI_URL = process.env.STRAPI_URL;
const STRAPI_TOKEN = process.env.STRAPI_WRITE_TOKEN;

async function strapiRequest(endpoint, method = 'GET', body = null) {
    const options = {
        method,
        headers: { 'Authorization': `Bearer ${STRAPI_TOKEN}` }
    };
    if (body) {
        options.headers['Content-Type'] = 'application/json';
        options.body = JSON.stringify(body);
    }
    const res = await fetch(`${STRAPI_URL}/api/${endpoint}`, options);
    
    if (!res.ok) throw new Error(`API Error ${res.status}: ${await res.text()}`);
    if (res.status === 204 || res.headers.get('content-length') === '0') return {}; 
    return res.json();
}

async function uploadImageToStrapi(localPath) {
    if (!fs.existsSync(localPath)) throw new Error(`Image not found: ${localPath}`);

    const form = new FormData();
    form.append('files', fs.createReadStream(localPath));

    // THE BRIDGE: Convert the Node stream into a raw Buffer that Native Fetch can easily digest
    const payloadBuffer = await new Promise((resolve, reject) => {
        const chunks = [];
        form.on('data', chunk => chunks.push(chunk));
        form.on('end', () => resolve(Buffer.concat(chunks)));
        form.on('error', reject);
    });

    const options = {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${STRAPI_TOKEN}`,
            ...form.getHeaders() // Injects the perfect multipart boundaries
        },
        body: payloadBuffer
    };

    const res = await fetch(`${STRAPI_URL}/api/upload`, options);
    
    if (!res.ok) throw new Error(`Upload failed: ${res.status} - ${await res.text()}`);
    
    const data = await res.json();
    return `${STRAPI_URL}${data[0].url}`; 
}

async function getOrCreateTerm(endpoint, termName, map) {
    if (map[termName]) return map[termName]; 
    console.log(`➕ Auto-syncing new ${endpoint}: ${termName}...`);
    const payload = { data: { Name: termName, publishedAt: new Date().toISOString() } };
    const res = await strapiRequest(endpoint, 'POST', payload);
    const newId = res.data.documentId || res.data.id; 
    map[termName] = newId;
    return newId;
}

async function runPublisher() {
    console.log("🚀 Starting V4 Auto-Publisher (Buffer Bridge Mode)...");
    let hasError = false;

    const categoryData = await strapiRequest('categories');
    const tagData = await strapiRequest('tags');
    const categoryMap = {};
    categoryData.data.forEach(c => categoryMap[c.Name || c.attributes?.Name] = c.documentId || c.id);
    const tagMap = {};
    tagData.data.forEach(t => tagMap[t.Name || t.attributes?.Name] = t.documentId || t.id);

    const authorsDir = path.join(__dirname, 'authors');
    if (!fs.existsSync(authorsDir)) return;

    const authors = fs.readdirSync(authorsDir);
    
    for (const author of authors) {
        const authorPath = path.join(authorsDir, author);
        if (!fs.statSync(authorPath).isDirectory()) continue;

        const articles = fs.readdirSync(authorPath);
        for (const articleFolder of articles) {
            const articlePath = path.join(authorPath, articleFolder);
            if (!fs.statSync(articlePath).isDirectory()) continue;

            const mdPath = path.join(articlePath, 'index.md');
            if (!fs.existsSync(mdPath)) continue;

            const contentRaw = fs.readFileSync(mdPath, 'utf8');
            const parsed = matter(contentRaw);
            const { title, slug, category, tags, delete: isDelete } = parsed.data;

            if (!slug) continue;

            if (isDelete === true) {
                console.log(`\n🗑️ EXPLICIT DELETION REQUESTED FOR: ${slug}`);
                try {
                    const search = await strapiRequest(`articles?filters[slug][$eq]=${encodeURIComponent(slug)}`);
                    if (search.data && search.data.length > 0) {
                        const docId = search.data[0].documentId || search.data[0].id;
                        await strapiRequest(`articles/${docId}`, 'DELETE');
                        console.log(`✅ Successfully deleted from CMS.`);
                    }
                } catch (error) {
                    console.error(`❌ Deletion failed:`, error.message);
                }
                continue; 
            }

            if (!title || !category) continue;

            console.log(`\n📄 Processing: ${author}/${articleFolder}/index.md`);
            try {
                let updatedContent = parsed.content;
                const imageRegex = /!\[([^\]]*)\]\(([^)]+)\)/g; 
                const matches = [...updatedContent.matchAll(imageRegex)];

                for (const match of matches) {
                    const imagePath = match[2];
                    if (!imagePath.startsWith('http')) {
                        const cleanPath = imagePath.replace(/^\.\//, ''); 
                        const absoluteLocalPath = path.join(articlePath, cleanPath);
                        
                        console.log(`   ⬆️ Uploading inline image: ${cleanPath}...`);
                        const liveUrl = await uploadImageToStrapi(absoluteLocalPath);
                        updatedContent = updatedContent.replace(imagePath, liveUrl);
                    }
                }

                const categoryId = await getOrCreateTerm('categories', category, categoryMap);
                const tagIds = [];
                if (tags) {
                    for (const t of tags) tagIds.push(await getOrCreateTerm('tags', t, tagMap));
                }

                const payload = {
                    data: {
                        Title: title,
                        slug: slug,
                        Content: updatedContent, 
                        category: categoryId,
                        tags: tagIds
                    }
                };

                const search = await strapiRequest(`articles?filters[slug][$eq]=${encodeURIComponent(slug)}`);
                if (search.data && search.data.length > 0) {
                    const targetId = search.data[0].documentId || search.data[0].id; 
                    console.log(`Updating existing article...`);
                    await strapiRequest(`articles/${targetId}`, 'PUT', payload);
                    console.log(`✅ Updated successfully!`);
                } else {
                    payload.data.publishedAt = new Date().toISOString();
                    console.log(`Creating new article...`);
                    await strapiRequest('articles', 'POST', payload);
                    console.log(`✅ Created successfully!`);
                }
            } catch (error) {
                console.error(`❌ Failed to process ${slug}:`, error.message);
                hasError = true;
            }
        }
    }

    if (hasError) process.exit(1);
}

runPublisher();