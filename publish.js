const fs = require('fs');
const path = require('path');
const matter = require('gray-matter');

// NOTICE: We completely removed "require('form-data')". We are using pure Native Web APIs now.

const STRAPI_URL = process.env.STRAPI_URL;
const STRAPI_TOKEN = process.env.STRAPI_WRITE_TOKEN;

async function strapiRequest(endpoint, method = 'GET', body = null) {
    console.log(`   -> [API CALL] ${method} /api/${endpoint}`);
    const options = {
        method,
        headers: { 'Authorization': `Bearer ${STRAPI_TOKEN}` }
    };
    if (body) {
        options.headers['Content-Type'] = 'application/json';
        options.body = JSON.stringify(body);
    }
    const res = await fetch(`${STRAPI_URL}/api/${endpoint}`, options);
    
    if (!res.ok) throw new Error(`[API Error] ${res.status}: ${await res.text()}`);
    if (res.status === 204 || res.headers.get('content-length') === '0') return {}; 
    return res.json();
}

async function uploadImageToStrapi(localPath) {
    console.log(`   -> [IMAGE] Starting upload sequence for: ${localPath}`);
    if (!fs.existsSync(localPath)) throw new Error(`Image not found on disk: ${localPath}`);

    // 1. Read file synchronously into memory
    const fileBuffer = fs.readFileSync(localPath);
    console.log(`   -> [IMAGE] File read successfully. Size: ${fileBuffer.length} bytes`);
    
    // 2. Determine exact mime type
    const ext = path.extname(localPath).replace('.', '').toLowerCase();
    let mimeType = 'image/jpeg';
    if (ext === 'png') mimeType = 'image/png';
    if (ext === 'webp') mimeType = 'image/webp';
    if (ext === 'gif') mimeType = 'image/gif';
    if (ext === 'svg') mimeType = 'image/svg+xml';

    // 3. Create NATIVE Web Blob and FormData
    console.log(`   -> [IMAGE] Packaging as Native Blob (${mimeType})...`);
    const blob = new Blob([fileBuffer], { type: mimeType });
    const form = new FormData(); 
    form.append('files', blob, path.basename(localPath));

    // 4. Send the payload
    console.log(`   -> [IMAGE] Sending POST request to Strapi /api/upload...`);
    const options = {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${STRAPI_TOKEN}`
            // DO NOT set Content-Type manually here. Native fetch calculates the multipart boundary automatically!
        },
        body: form
    };

    const res = await fetch(`${STRAPI_URL}/api/upload`, options);
    if (!res.ok) throw new Error(`Upload failed: ${res.status} - ${await res.text()}`);
    
    const data = await res.json();
    console.log(`   -> [IMAGE] ✅ Upload Success! Live URL generated: ${data[0].url}`);
    return `${STRAPI_URL}${data[0].url}`; 
}

async function getOrCreateTerm(endpoint, termName, map) {
    if (map[termName]) return map[termName]; 
    console.log(`   -> [MAPPING] Auto-syncing new ${endpoint}: ${termName}...`);
    const payload = { data: { Name: termName, publishedAt: new Date().toISOString() } };
    const res = await strapiRequest(endpoint, 'POST', payload);
    const newId = res.data.documentId || res.data.id; 
    map[termName] = newId;
    return newId;
}

async function runPublisher() {
    console.log("🚀 ================================================");
    console.log("🚀 STARTING V5 AUTO-PUBLISHER (Maximum Visibility)");
    console.log("🚀 ================================================\n");
    let hasError = false;

    try {
        console.log("🛠️ Step 1: Fetching existing Categories and Tags...");
        const categoryData = await strapiRequest('categories');
        const tagData = await strapiRequest('tags');
        const categoryMap = {};
        categoryData.data.forEach(c => categoryMap[c.Name || c.attributes?.Name] = c.documentId || c.id);
        const tagMap = {};
        tagData.data.forEach(t => tagMap[t.Name || t.attributes?.Name] = t.documentId || t.id);
        console.log("✅ Step 1 Complete: Taxonomy maps built.\n");

        const authorsDir = path.join(__dirname, 'authors');
        if (!fs.existsSync(authorsDir)) {
            console.log("❌ No authors directory found. Aborting.");
            return;
        }

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

                console.log(`\n==================================================`);
                console.log(`📄 PROCESSING FILE: ${author}/${articleFolder}/index.md`);
                console.log(`==================================================`);

                const contentRaw = fs.readFileSync(mdPath, 'utf8');
                const parsed = matter(contentRaw);
                const { title, slug, category, tags, delete: isDelete } = parsed.data;

                if (!slug) {
                    console.log("⚠️ No slug found in frontmatter. Skipping.");
                    continue;
                }

                if (isDelete === true) {
                    console.log(`🗑️ EXPLICIT DELETION FLAG DETECTED FOR: ${slug}`);
                    const search = await strapiRequest(`articles?filters[slug][$eq]=${encodeURIComponent(slug)}`);
                    if (search.data && search.data.length > 0) {
                        const docId = search.data[0].documentId || search.data[0].id;
                        await strapiRequest(`articles/${docId}`, 'DELETE');
                        console.log(`✅ Successfully deleted from CMS.`);
                    }
                    continue; 
                }

                if (!title || !category) {
                    console.log("⚠️ Missing title or category. Skipping.");
                    continue;
                }

                let updatedContent = parsed.content;
                const imageRegex = /!\[([^\]]*)\]\(([^)]+)\)/g; 
                const matches = [...updatedContent.matchAll(imageRegex)];

                if (matches.length > 0) {
                    console.log(`\n🖼️ Step 2: Extracting and Processing ${matches.length} Inline Images...`);
                    for (const match of matches) {
                        const imagePath = match[2];
                        if (!imagePath.startsWith('http')) {
                            const cleanPath = imagePath.replace(/^\.\//, ''); 
                            const absoluteLocalPath = path.join(articlePath, cleanPath);
                            const liveUrl = await uploadImageToStrapi(absoluteLocalPath);
                            updatedContent = updatedContent.replace(imagePath, liveUrl);
                        }
                    }
                }

                console.log(`\n🔗 Step 3: Mapping Relations...`);
                const categoryId = await getOrCreateTerm('categories', category, categoryMap);
                const tagIds = [];
                if (tags) {
                    for (const t of tags) tagIds.push(await getOrCreateTerm('tags', t, tagMap));
                }

                console.log(`\n📦 Step 4: Building Final CMS Payload...`);
                const payload = {
                    data: {
                        Title: title,
                        slug: slug,
                        Content: updatedContent, 
                        category: categoryId,
                        tags: tagIds
                    }
                };
                
                console.log(`\n📤 Step 5: Executing Upsert (Database Save)...`);
                const search = await strapiRequest(`articles?filters[slug][$eq]=${encodeURIComponent(slug)}`);
                if (search.data && search.data.length > 0) {
                    const targetId = search.data[0].documentId || search.data[0].id; 
                    console.log(`   -> Article exists. Executing PUT to update documentId: ${targetId}`);
                    await strapiRequest(`articles/${targetId}`, 'PUT', payload);
                    console.log(`✅ SUCCESS: Article Updated!`);
                } else {
                    console.log(`   -> Article is new. Executing POST to create.`);
                    payload.data.publishedAt = new Date().toISOString();
                    await strapiRequest('articles', 'POST', payload);
                    console.log(`✅ SUCCESS: Article Created!`);
                }
            }
        }
    } catch (globalError) {
        console.error(`\n🚨 FATAL PIPELINE CRASH:`, globalError.message);
        hasError = true;
    }

    console.log("\n🏁 ================================================");
    console.log("🏁 PUBLISHER RUN COMPLETE.");
    if (hasError) {
        console.log("❌ Finished with errors.");
        process.exit(1);
    } else {
        console.log("✅ Finished cleanly.");
        process.exit(0);
    }
}

runPublisher();