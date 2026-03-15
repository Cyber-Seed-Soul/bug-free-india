const fs = require('fs');
const path = require('path');
const matter = require('gray-matter');
const FormData = require('form-data');

const STRAPI_URL = process.env.STRAPI_URL;
const STRAPI_TOKEN = process.env.STRAPI_WRITE_TOKEN;

// --- SECURITY GUARDRAILS ---
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB Limit
const ALLOWED_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif', '.svg'];

async function strapiRequest(endpoint, method = 'GET', body = null) {
    const options = {
        method,
        headers: {
            'Authorization': `Bearer ${STRAPI_TOKEN}`
        }
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
    if (!fs.existsSync(localPath)) throw new Error(`Image not found: ${localPath}`);
    
    const ext = path.extname(localPath).toLowerCase();
    if (!ALLOWED_EXTENSIONS.includes(ext)) {
        throw new Error(`Security Violation: Extension ${ext} not allowed.`);
    }

    const stats = fs.statSync(localPath);
    if (stats.size > MAX_FILE_SIZE) {
        throw new Error(`Size Violation: File exceeds 5MB limit.`);
    }

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
    console.log(`➕ Auto-syncing new ${endpoint}: ${termName}`);
    const payload = { data: { Name: termName, publishedAt: new Date().toISOString() } };
    const res = await strapiRequest(endpoint, 'POST', payload);
    const newId = res.data.documentId || res.data.id; 
    map[termName] = newId;
    return newId;
}

async function runPublisher() {
    console.log("🚀 Starting Auto-Publisher...");
    let hasError = false;

    // 1. Map CMS Relations
    const categoryData = await strapiRequest('categories');
    const tagData = await strapiRequest('tags');
    const categoryMap = {};
    categoryData.data.forEach(c => categoryMap[c.Name || c.name || c.attributes?.Name] = c.documentId || c.id);
    const tagMap = {};
    tagData.data.forEach(t => tagMap[t.Name || t.name || t.attributes?.Name] = t.documentId || t.id);

    const submissionsDir = path.join(__dirname, 'content', 'submissions');
    const files = fs.readdirSync(submissionsDir).filter(f => f.endsWith('.md'));

    for (const file of files) {
        console.log(`\n📄 Processing: ${file}`);
        const contentRaw = fs.readFileSync(path.join(submissionsDir, file), 'utf8');
        const parsed = matter(contentRaw);
        const { title, slug, category, tags } = parsed.data;

        if (!title || !slug || !category) {
            console.error(`❌ Skipped: Missing frontmatter in ${file}`);
            hasError = true;
            continue;
        }

        try {
            // 2. INLINE IMAGE SWAPPER
            let updatedContent = parsed.content;
            const imageRegex = /!\[([^\]]*)\]\(([^)]+)\)/g; 
            const matches = [...updatedContent.matchAll(imageRegex)];

            for (const match of matches) {
                const imagePath = match[2];
                if (!imagePath.startsWith('http')) {
                    const cleanPath = imagePath.replace(/^\.\//, ''); 
                    const absoluteLocalPath = path.join(submissionsDir, cleanPath);
                    
                    console.log(`   ⬆️ Uploading inline image: ${cleanPath}...`);
                    const liveUrl = await uploadImageToStrapi(absoluteLocalPath);
                    updatedContent = updatedContent.replace(imagePath, liveUrl);
                }
            }

            // 3. Sync Categories & Tags
            const categoryId = await getOrCreateTerm('categories', category, categoryMap);
            const tagIds = [];
            if (tags) {
                for (const t of tags) tagIds.push(await getOrCreateTerm('tags', t, tagMap));
            }

            // 4. Build Base Payload (NO publishedAt here)
            const payload = {
                data: {
                    Title: title,
                    slug: slug,
                    Content: updatedContent, 
                    category: categoryId,
                    tags: tagIds
                }
            };

            // 5. Update or Create Logic
            const search = await strapiRequest(`articles?filters[slug][$eq]=${encodeURIComponent(slug)}`);
            if (search.data && search.data.length > 0) {
                const targetId = search.data[0].documentId || search.data[0].id; 
                // UPDATE: No publishedAt sent to avoid the 403 error
                console.log(`Updating existing article (ID/DocID: ${targetId})...`);
                await strapiRequest(`articles/${targetId}`, 'PUT', payload);
                console.log(`✅ Updated successfully!`);
            } else {
                // CREATE: Attach publishedAt to bypass Draft state
                payload.data.publishedAt = new Date().toISOString();
                console.log(`Creating new article...`);
                await strapiRequest('articles', 'POST', payload);
                console.log(`✅ Created successfully!`);
            }
        } catch (error) {
            console.error(`❌ Failed to process ${file}:`, error.message);
            hasError = true;
        }
    }

    if (hasError) process.exit(1);
}

runPublisher();