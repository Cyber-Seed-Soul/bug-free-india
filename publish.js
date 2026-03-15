const fs = require('fs');
const path = require('path');
const matter = require('gray-matter');

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
    return res.json();
}

async function uploadImageToStrapi(localPath) {
    // FIX: Using Native Node 18+ Blob and FormData capabilities
    const fileBuffer = fs.readFileSync(localPath);
    const ext = path.extname(localPath).replace('.', '').toLowerCase();
    
    let mimeType = 'image/jpeg';
    if (ext === 'png') mimeType = 'image/png';
    if (ext === 'webp') mimeType = 'image/webp';
    if (ext === 'gif') mimeType = 'image/gif';
    if (ext === 'svg') mimeType = 'image/svg+xml';

    const blob = new Blob([fileBuffer], { type: mimeType });
    const form = new FormData(); 
    form.append('files', blob, path.basename(localPath));

    const options = {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${STRAPI_TOKEN}`
            // Note: Native fetch + FormData automatically sets multipart boundaries
        },
        body: form
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
    console.log("🚀 Starting V2 Auto-Publisher (Upsert Mode)...");
    let hasError = false;

    // 1. Map Relations (Category & Tags)
    const categoryData = await strapiRequest('categories');
    const tagData = await strapiRequest('tags');
    const categoryMap = {};
    categoryData.data.forEach(c => categoryMap[c.Name || c.attributes?.Name] = c.documentId || c.id);
    const tagMap = {};
    tagData.data.forEach(t => tagMap[t.Name || t.attributes?.Name] = t.documentId || t.id);

    // 2. Traverse Authors Directory
    // Bot V2 now handles multiple authors and multiple nested articles.
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

            console.log(`\n📄 Processing: ${author}/${articleFolder}/index.md`);
            const contentRaw = fs.readFileSync(mdPath, 'utf8');
            const parsed = matter(contentRaw);
            const { title, slug, category, tags } = parsed.data;

            if (!title || !slug || !category) {
                console.error(`❌ Skipped ${articleFolder}: Missing essential frontmatter.`);
                hasError = true;
                continue;
            }

            try {
                // 3. Nested Inline Image Swapper
                let updatedContent = parsed.content;
                const imageRegex = /!\[([^\]]*)\]\(([^)]+)\)/g; 
                const matches = [...updatedContent.matchAll(imageRegex)];

                for (const match of matches) {
                    const imagePath = match[2];
                    if (!imagePath.startsWith('http')) {
                        // Local paths like "./images/my-pic.png" are resolved relative to the article folder
                        const cleanPath = imagePath.replace(/^\.\//, ''); 
                        const absoluteLocalPath = path.join(articlePath, cleanPath);
                        
                        console.log(`   ⬆️ Uploading inline image: ${cleanPath}...`);
                        const liveUrl = await uploadImageToStrapi(absoluteLocalPath);
                        updatedContent = updatedContent.replace(imagePath, liveUrl);
                    }
                }

                // 4. Sync Categories & Tags (Relations are essential, but the missing Author field is fine)
                const categoryId = await getOrCreateTerm('categories', category, categoryMap);
                const tagIds = [];
                if (tags) {
                    for (const t of tags) tagIds.push(await getOrCreateTerm('tags', t, tagMap));
                }

                // 5. Build Explicit CMS Payload (Case-sensitive API keys must match Strapi)
                const payload = {
                    data: {
                        Title: title,
                        slug: slug,
                        Content: updatedContent, 
                        category: categoryId,
                        tags: tagIds
                        // Note: author field is intentionally ignored for now as it doesn't exist in the schema
                    }
                };

                // 6. THE UPSERT LOGIC (Search -> PUT or POST)
                const search = await strapiRequest(`articles?filters[slug][$eq]=${encodeURIComponent(slug)}`);
                if (search.data && search.data.length > 0) {
                    // Case A: Article exists. Strapi V5 uses documentId for updates.
                    const targetId = search.data[0].documentId || search.data[0].id; 
                    console.log(`Updating existing article with documentId: ${targetId}...`);
                    await strapiRequest(`articles/${targetId}`, 'PUT', payload);
                    console.log(`✅ Updated successfully!`);
                } else {
                    // Case B: Article is new. For a POST (creation), we must explicitly set publication date.
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