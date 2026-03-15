const fs = require('fs');
const path = require('path');
const matter = require('gray-matter');
const FormData = require('form-data');

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
    const form = new FormData();
    form.append('files', fs.createReadStream(localPath));

    const options = {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${STRAPI_TOKEN}`,
            ...form.getHeaders()
        },
        body: form
    };

    const res = await fetch(`${STRAPI_URL}/api/upload`, options);
    if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
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
    console.log("🚀 Starting Multi-Tenant Auto-Publisher V2...");

    // 1. Map Relations (Category & Tags)
    const categoryData = await strapiRequest('categories');
    const tagData = await strapiRequest('tags');
    const categoryMap = {};
    categoryData.data.forEach(c => categoryMap[c.Name || c.attributes?.Name] = c.documentId || c.id);
    const tagMap = {};
    tagData.data.forEach(t => tagMap[t.Name || t.attributes?.Name] = t.documentId || t.id);

    // 2. Resolve Multi-Tenant Folder Path
    // Bot V2 uses: authors/<github_username>/<slug>/index.md
    const filename = process.argv[2] || 'authors/ScientificSam/how-to-protect-your-data-yourself-in-india/index.md';
    console.log(`\n📄 Processing: ${filename}...`);
    const filePath = path.join(__dirname, filename);
    const articleFolder = path.dirname(filePath);

    if (!fs.existsSync(filePath)) {
        console.error("❌ File not found. Pipeline aborted.");
        process.exit(1);
    }

    const contentRaw = fs.readFileSync(filePath, 'utf8');
    const parsed = matter(contentRaw);
    const { title, slug, author, category, tags } = parsed.data;

    try {
        // 3. Resolve Inline Images
        let updatedContent = parsed.content;
        const imageRegex = /!\[([^\]]*)\]\(([^)]+)\)/g; 
        const matches = [...updatedContent.matchAll(imageRegex)];

        for (const match of matches) {
            const imagePath = match[2];
            if (!imagePath.startsWith('http')) {
                // If path is local (./images/xyz.png), resolve it relative to the specific article folder
                const absoluteLocalPath = path.resolve(articleFolder, imagePath);
                console.log(`   ⬆️ Uploading inline image: ${imagePath}...`);
                const liveUrl = await uploadImageToStrapi(absoluteLocalPath);
                updatedContent = updatedContent.replace(imagePath, liveUrl);
            }
        }

        // 4. Create Relation Fields on the fly
        if (!category) throw new Error("Missing required 'category' in frontmatter.");
        const categoryId = await getOrCreateTerm('categories', category, categoryMap);
        
        const tagIds = [];
        if (tags) {
            for (const t of tags) {
                tagIds.push(await getOrCreateTerm('tags', t, tagMap));
            }
        }

        // 5. Build Final CMS Payload
        const payload = {
            data: {
                Title: title,
                slug: slug,
                Author: author,
                Content: updatedContent, 
                category: categoryId,
                tags: tagIds
            }
        };

        // 6. THE UPSERT (Create or Update Logic)
        const search = await strapiRequest(`articles?filters[slug][$eq]=${slug}`);
        
        if (search.data && search.data.length > 0) {
            // Case A: Article exists. We must use the DOCUMENT ID for Strapi v5 Document API.
            const documentId = search.data[0].documentId || search.data[0].id; 
            console.log(`Updating existing article with documentId: ${documentId}...`);
            await strapiRequest(`articles/${documentId}`, 'PUT', payload);
            console.log(`✅ Updated successfully!`);
        } else {
            // Case B: Article is new. We must explicitly set the publication time.
            payload.data.publishedAt = new Date().toISOString();
            console.log(`Creating new article...`);
            await strapiRequest('articles', 'POST', payload);
            console.log(`✅ Created successfully!`);
        }

    } catch (error) {
        console.error('❌ Failed:', error.message);
        process.exit(1);
    }
}

runPublisher();