const fs = require('fs');
const path = require('path');
const matter = require('gray-matter');
const FormData = require('form-data');

// NEGATIVE SPACE FIX: Strip any accidental trailing slashes from the GitHub Secret
const STRAPI_URL = (process.env.STRAPI_URL || '').replace(/\/$/, '');
const STRAPI_TOKEN = process.env.STRAPI_WRITE_TOKEN;

async function strapiRequest(endpoint, method = 'GET', body = null) {
    console.log(`   -> [API] ${method} /api/${endpoint}`);
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

async function handleImage(localPath, authorName, articleSlug) {
    console.log(`   -> [IMAGE] Processing: ${localPath}`);
    
    // EDGE CASE: Author provided a bad path or file doesn't exist
    if (!fs.existsSync(localPath)) {
        console.log(`   -> ⚠️ [WARNING] Image missing on disk. Skipping upload but keeping text.`);
        return null; 
    }

    // EDGE CASE: Prevent name collisions by tagging files with the author and slug
    const rawFileName = path.basename(localPath);
    const uniqueFileName = `${authorName}_${articleSlug}_${rawFileName}`;

    // 1. "SKIP IF EXISTS" LOGIC
    console.log(`   -> [IMAGE] Checking CMS cache for: ${uniqueFileName}...`);
    // Note: Strapi upload/files endpoint returns an array directly
    const searchRes = await strapiRequest(`upload/files?filters[name][$eq]=${encodeURIComponent(uniqueFileName)}`);
    
    if (Array.isArray(searchRes) && searchRes.length > 0) {
        console.log(`   -> [IMAGE] ✅ Found in CMS! Skipping upload.`);
        return `${STRAPI_URL}${searchRes[0].url}`;
    }

    // 2. UPLOAD LOGIC (Using Bulletproof Buffer Bridge)
    console.log(`   -> [IMAGE] Not found in cache. Initiating secure upload...`);
    const form = new FormData();
    form.append('files', fs.createReadStream(localPath), { filename: uniqueFileName });

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
            ...form.getHeaders()
        },
        body: payloadBuffer
    };

    const res = await fetch(`${STRAPI_URL}/api/upload`, options);
    if (!res.ok) throw new Error(`Upload failed: ${res.status} - ${await res.text()}`);
    
    const data = await res.json();
    console.log(`   -> [IMAGE] ✅ Uploaded successfully!`);
    return `${STRAPI_URL}${data[0].url}`; 
}

async function getOrCreateTerm(endpoint, termName, map) {
    if (!termName) return null;
    if (map[termName]) return map[termName]; 
    
    console.log(`   -> [TAXONOMY] Creating new ${endpoint}: ${termName}...`);
    const payload = { data: { Name: termName, publishedAt: new Date().toISOString() } };
    const res = await strapiRequest(endpoint, 'POST', payload);
    const newId = res.data.documentId || res.data.id; 
    map[termName] = newId;
    return newId;
}

async function runPublisher() {
    console.log("🚀 STARTING V6 FOOLPROOF PUBLISHER ENGINE\n");
    let hasError = false;

    try {
        console.log("🛠️ Mapping existing Taxonomies...");
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

                // EDGE CASE: Isolate each article in a try/catch so one bad file doesn't stop the others
                try {
                    console.log(`\n==================================================`);
                    console.log(`📄 PROCESSING: ${author}/${articleFolder}`);
                    
                    const contentRaw = fs.readFileSync(mdPath, 'utf8');
                    const parsed = matter(contentRaw);
                    
                    // EDGE CASE: Handle missing or sloppy frontmatter
                    const slug = parsed.data.slug || articleFolder.toLowerCase().replace(/[^a-z0-9]+/g, '-');
                    const title = parsed.data.title || "Untitled Article";
                    const category = parsed.data.category || "General";
                    const tags = parsed.data.tags || [];
                    const isDelete = parsed.data.delete === true;

                    // DELETE API CALL
                    if (isDelete) {
                        console.log(`   -> 🗑️ EXPLICIT DELETION FLAG DETECTED.`);
                        const search = await strapiRequest(`articles?filters[slug][$eq]=${encodeURIComponent(slug)}`);
                        if (search.data && search.data.length > 0) {
                            const docId = search.data[0].documentId || search.data[0].id;
                            await strapiRequest(`articles/${docId}`, 'DELETE');
                            console.log(`   -> ✅ Deleted from CMS.`);
                        } else {
                            console.log(`   -> ⚠️ Article not found in CMS. Already deleted.`);
                        }
                        continue; 
                    }

                    // IMAGE SWAPPER
                    let updatedContent = parsed.content;
                    const imageRegex = /!\[([^\]]*)\]\(([^)]+)\)/g; 
                    const matches = [...updatedContent.matchAll(imageRegex)];

                    if (matches.length > 0) {
                        for (const match of matches) {
                            const imagePath = match[2];
                            if (!imagePath.startsWith('http')) {
                                const cleanPath = imagePath.replace(/^\.\//, ''); 
                                const absoluteLocalPath = path.join(articlePath, cleanPath);
                                
                                const liveUrl = await handleImage(absoluteLocalPath, author, slug);
                                if (liveUrl) {
                                    updatedContent = updatedContent.replace(imagePath, liveUrl);
                                }
                            }
                        }
                    }

                    // RELATION MAPPING
                    const categoryId = await getOrCreateTerm('categories', category, categoryMap);
                    const tagIds = [];
                    for (const t of tags) {
                        tagIds.push(await getOrCreateTerm('tags', t, tagMap));
                    }

                    // BUILD PAYLOAD
                    const payload = {
                        data: {
                            Title: title,
                            slug: slug,
                            Content: updatedContent, 
                            category: categoryId,
                            tags: tagIds
                        }
                    };
                    
                    // CREATE / UPDATE API CALL
                    const search = await strapiRequest(`articles?filters[slug][$eq]=${encodeURIComponent(slug)}`);
                    if (search.data && search.data.length > 0) {
                        const targetId = search.data[0].documentId || search.data[0].id; 
                        console.log(`   -> Executing PUT to update existing article...`);
                        await strapiRequest(`articles/${targetId}`, 'PUT', payload);
                        console.log(`✅ SUCCESS: Article Updated!`);
                    } else {
                        console.log(`   -> Executing POST to create new article...`);
                        payload.data.publishedAt = new Date().toISOString();
                        await strapiRequest('articles', 'POST', payload);
                        console.log(`✅ SUCCESS: Article Created!`);
                    }

                } catch (articleError) {
                    console.error(`❌ FAILED on ${articleFolder}:`, articleError.message);
                    hasError = true;
                }
            }
        }
    } catch (globalError) {
        console.error(`🚨 CRITICAL FAILURE:`, globalError.message);
        hasError = true;
    }

    if (hasError) {
        console.log("\n❌ Publisher finished with non-fatal errors.");
        process.exit(1);
    } else {
        console.log("\n✅ Publisher finished flawlessly.");
        process.exit(0);
    }
}

runPublisher();