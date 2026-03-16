const fs = require('fs');
const path = require('path');
const matter = require('gray-matter');
const FormData = require('form-data');
const crypto = require('crypto');

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
    
    if (!fs.existsSync(localPath)) {
        console.log(`   -> ⚠️ [WARNING] Image missing on disk. Proceeding without it.`);
        return null; 
    }

    const ext = path.extname(localPath).toLowerCase();
    const fileBuffer = fs.readFileSync(localPath);

    const hashSum = crypto.createHash('md5');
    hashSum.update(fileBuffer);
    const fileHash = hashSum.digest('hex').substring(0, 10);
    const uniqueFileName = `${authorName}_${articleSlug}_${fileHash}${ext}`;

    // 1. SMART CACHE CHECK (DECOUPLED)
    console.log(`   -> [IMAGE] Checking CMS cache...`);
    try {
        const searchRes = await strapiRequest(`upload/files?filters[name][$eq]=${encodeURIComponent(uniqueFileName)}`);
        if (Array.isArray(searchRes) && searchRes.length > 0) {
            console.log(`   -> [IMAGE] ✅ Unchanged image found in CMS cache!`);
            return `${STRAPI_URL}${searchRes[0].url}`;
        }
    } catch (cacheError) {
        // We no longer crash here. We just warn and proceed.
        console.log(`   -> ⚠️ [WARNING] Cache read denied (403). Bypassing cache optimization.`);
    }

    // 2. SECURE UPLOAD LOGIC (DECOUPLED)
    console.log(`   -> [IMAGE] Initiating upload to server...`);
    try {
        const form = new FormData();
        form.append('files', fileBuffer, { filename: uniqueFileName });

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
        if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
        
        const data = await res.json();
        console.log(`   -> [IMAGE] ✅ Uploaded successfully!`);
        return `${STRAPI_URL}${data[0].url}`; 
    } catch (uploadError) {
        // If the upload totally fails, we return null so the pipeline survives and the text publishes.
        console.log(`   -> ❌ [ERROR] Image upload failed entirely. Skipping image to save article text.`);
        return null; 
    }
}

async function getOrCreateTerm(endpoint, termName, map) {
    if (!termName) return null;
    if (map[termName]) return map[termName]; 
    
    console.log(`   -> [TAXONOMY] Auto-creating missing ${endpoint}: ${termName}...`);
    try {
        const payload = { data: { Name: termName, publishedAt: new Date().toISOString() } };
        const res = await strapiRequest(endpoint, 'POST', payload);
        const newId = res.data.documentId || res.data.id; 
        map[termName] = newId;
        return newId;
    } catch (e) {
        console.log(`   -> ❌ [ERROR] Could not create taxonomy. Skipping relation.`);
        return null;
    }
}

async function runPublisher() {
    console.log("🚀 STARTING V8 'INDESTRUCTIBLE' PUBLISHER ENGINE\n");

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

                try {
                    console.log(`\n==================================================`);
                    console.log(`📄 PROCESSING: ${author}/${articleFolder}`);
                    
                    const contentRaw = fs.readFileSync(mdPath, 'utf8');
                    const parsed = matter(contentRaw);
                    
                    const slug = parsed.data.slug || articleFolder.toLowerCase().replace(/[^a-z0-9]+/g, '-');
                    const title = parsed.data.title || "Untitled Article";
                    const category = parsed.data.category || "General";
                    const tags = parsed.data.tags || [];

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
                        const tId = await getOrCreateTerm('tags', t, tagMap);
                        if (tId) tagIds.push(tId);
                    }

                    // BUILD THE PAYLOAD
                    const payload = {
                        data: {
                            Title: title,
                            slug: slug,
                            Content: updatedContent, 
                            category: categoryId,
                            tags: tagIds
                        }
                    };
                    
                    // CORE UPSERT LOGIC (The API calls you asked for)
                    const search = await strapiRequest(`articles?filters[slug][$eq]=${encodeURIComponent(slug)}`);
                    
                    if (search.data && search.data.length > 0) {
                        // UPDATE PATH
                        const targetId = search.data[0].documentId || search.data[0].id; 
                        console.log(`   -> Article exists. Executing PUT to update...`);
                        await strapiRequest(`articles/${targetId}`, 'PUT', payload);
                        console.log(`✅ SUCCESS: Article Updated!`);
                    } else {
                        // CREATE PATH
                        console.log(`   -> Article not found. Executing POST to create...`);
                        payload.data.publishedAt = new Date().toISOString();
                        await strapiRequest('articles', 'POST', payload);
                        console.log(`✅ SUCCESS: Article Created!`);
                    }

                } catch (articleError) {
                    // This only triggers if the text formatting is completely destroyed or DB is down
                    console.error(`❌ FAILED on ${articleFolder}:`, articleError.message);
                }
            }
        }
    } catch (globalError) {
        console.error(`🚨 SYSTEM DOWN: Cannot reach Strapi. Check Token/URL.`, globalError.message);
        process.exit(1);
    }

    console.log("\n✅ Pipeline Complete.");
}

runPublisher();