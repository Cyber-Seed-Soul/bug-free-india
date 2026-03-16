const fs = require('fs');
const path = require('path');
const matter = require('gray-matter');
const crypto = require('crypto');
const FormData = require('form-data'); // The final dependency

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
    if (!fs.existsSync(localPath)) return null; 

    const ext = path.extname(localPath).toLowerCase();
    const fileBuffer = fs.readFileSync(localPath);
    
    const hashSum = crypto.createHash('md5');
    hashSum.update(fileBuffer);
    const fileHash = hashSum.digest('hex').substring(0, 10);
    const uniqueFileName = `${authorName}_${articleSlug}_${fileHash}${ext}`;

    console.log(`   -> [IMAGE] Checking CMS cache...`);
    try {
        const searchRes = await strapiRequest(`upload/files?filters[name][$eq]=${encodeURIComponent(uniqueFileName)}`);
        if (Array.isArray(searchRes) && searchRes.length > 0) {
            console.log(`   -> [IMAGE] ✅ Found in CMS cache! Skipping upload.`);
            return `${STRAPI_URL}${searchRes[0].url}`;
        }
    } catch (cacheError) {
        console.log(`   -> ⚠️ [WARNING] Cache read denied. Bypassing check.`);
    }

    console.log(`   -> [IMAGE] Initiating secure upload...`);
    try {
        const form = new FormData();
        // Passing the raw buffer directly prevents native fetch bugs
        form.append('files', fileBuffer, { filename: uniqueFileName });

        const options = {
            method: 'POST',
            headers: { 
                'Authorization': `Bearer ${STRAPI_TOKEN}`,
                ...form.getHeaders() // Injects perfect multipart boundaries
            }, 
            // THE SILVER BULLET: .getBuffer() converts it to memory synchronously. No streams to deadlock!
            body: form.getBuffer() 
        };

        const res = await fetch(`${STRAPI_URL}/api/upload`, options);
        if (!res.ok) throw new Error(`Upload failed: ${res.status} - ${await res.text()}`);
        
        const data = await res.json();
        console.log(`   -> [IMAGE] ✅ Uploaded successfully!`);
        return `${STRAPI_URL}${data[0].url}`; 
    } catch (uploadError) {
        console.log(`   -> ❌ [ERROR] Image upload failed: ${uploadError.message}. Skipping image to save text.`);
        return null; 
    }
}

async function getOrCreateTerm(endpoint, termName, map) {
    if (!termName) return null;
    if (map[termName]) return map[termName]; 
    
    console.log(`   -> [TAXONOMY] Auto-creating: ${termName}...`);
    try {
        const payload = { data: { Name: termName, publishedAt: new Date().toISOString() } };
        const res = await strapiRequest(endpoint, 'POST', payload);
        const newId = res.data.documentId || res.data.id; 
        map[termName] = newId;
        return newId;
    } catch (e) {
        return null;
    }
}

async function runPublisher() {
    console.log("🚀 STARTING THE BULLETPROOF PUBLISHER ENGINE\n");

    try {
        console.log("🛠️ Mapping Taxonomies...");
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
                    
                    if (!parsed.data.slug) {
                        console.log(`   -> ⚠️ [SKIPPED] No frontmatter/slug found.`);
                        continue;
                    }

                    const slug = parsed.data.slug;
                    const title = parsed.data.title || "Untitled Article";
                    const category = parsed.data.category || "General";
                    const tags = parsed.data.tags || [];

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

                    const categoryId = await getOrCreateTerm('categories', category, categoryMap);
                    const tagIds = [];
                    for (const t of tags) {
                        const tId = await getOrCreateTerm('tags', t, tagMap);
                        if (tId) tagIds.push(tId);
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
                    
                    console.log(`   -> [DATABASE] Executing Upsert...`);
                    const search = await strapiRequest(`articles?filters[slug][$eq]=${encodeURIComponent(slug)}`);
                    
                    if (search.data && search.data.length > 0) {
                        const targetId = search.data[0].documentId || search.data[0].id; 
                        await strapiRequest(`articles/${targetId}`, 'PUT', payload);
                        console.log(`✅ SUCCESS: Article Updated!`);
                    } else {
                        payload.data.publishedAt = new Date().toISOString();
                        await strapiRequest('articles', 'POST', payload);
                        console.log(`✅ SUCCESS: Article Created!`);
                    }

                } catch (articleError) {
                    console.error(`❌ FAILED on ${articleFolder}:`, articleError.message);
                }
            }
        }
    } catch (globalError) {
        console.error(`🚨 SYSTEM DOWN: Cannot reach Strapi.`, globalError.message);
        process.exit(1);
    }

    console.log("\n✅ Pipeline Complete.");
}

runPublisher();