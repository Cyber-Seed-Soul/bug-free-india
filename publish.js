const fs = require('fs');
const path = require('path');
const matter = require('gray-matter');

const STRAPI_URL = process.env.STRAPI_URL;
const STRAPI_TOKEN = process.env.STRAPI_WRITE_TOKEN;

async function strapiRequest(endpoint, method = 'GET', body = null) {
    const options = {
        method,
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${STRAPI_TOKEN}`
        }
    };
    if (body) options.body = JSON.stringify(body);
    
    const res = await fetch(`${STRAPI_URL}/api/${endpoint}`, options);
    if (!res.ok) throw new Error(`API Error ${res.status}: ${await res.text()}`);
    return res.json();
}

// Auto-Sync Function for Tags and Categories
async function getOrCreateTerm(endpoint, termName, map) {
    if (map[termName]) return map[termName]; // Already exists in CMS
    
    console.log(`➕ Auto-syncing new ${endpoint} to CMS: ${termName}`);
    try {
        // Standard Strapi schema convention uses 'Name' for tags/categories. 
        // If your database uses 'Title' instead of 'Name', we will get a 400 error here.
        const payload = { 
            data: { 
                Name: termName, 
                publishedAt: new Date().toISOString() 
            } 
        };
        const res = await strapiRequest(endpoint, 'POST', payload);
        
        // Handle Strapi v5 documentId vs Strapi v4 id
        const newId = res.data.documentId || res.data.id; 
        map[termName] = newId;
        return newId;
    } catch (e) {
        console.error(`❌ Failed to create ${endpoint} '${termName}'. Error:`, e.message);
        throw e;
    }
}

async function runPublisher() {
    console.log("🚀 Starting Auto-Publisher...");
    let hasError = false;

    // 1. Fetch CMS Map
    const categoryData = await strapiRequest('categories');
    const tagData = await strapiRequest('tags');
    
    const categoryMap = {};
    categoryData.data.forEach(c => {
        const catName = c.name || c.Name || c.Title || c.attributes?.name || c.attributes?.Name;
        if(catName) categoryMap[catName] = c.documentId || c.id; // Store documentId for v5 support
    });
    
    const tagMap = {};
    tagData.data.forEach(t => {
        const tagName = t.name || t.Name || t.Title || t.attributes?.name || t.attributes?.Name;
        if(tagName) tagMap[tagName] = t.documentId || t.id;
    });

    // 2. Read Submissions
    const submissionsDir = path.join(__dirname, 'content', 'submissions');
    const files = fs.readdirSync(submissionsDir).filter(f => f.endsWith('.md'));

    for (const file of files) {
        console.log(`\n📄 Processing: ${file}`);
        const content = fs.readFileSync(path.join(submissionsDir, file), 'utf8');
        const parsed = matter(content);
        const { title, slug, category, tags } = parsed.data;

        if (!title || !slug || !category) {
            console.error(`❌ Skipped: Missing title, slug, or category in ${file}`);
            hasError = true;
            continue;
        }

        try {
            // 3. AUTO-SYNC: Ensure Category and Tags exist in CMS
            const categoryId = await getOrCreateTerm('categories', category, categoryMap);
            
            const tagIds = [];
            if (tags && Array.isArray(tags)) {
                for (const t of tags) {
                    const tId = await getOrCreateTerm('tags', t, tagMap);
                    tagIds.push(tId);
                }
            }

            // 4. Build Payload
            const payload = {
                data: {
                    Title: title,
                    slug: slug,
                    Content: parsed.content,
                    category: categoryId,
                    tags: tagIds,
                    publishedAt: new Date().toISOString()
                }
            };

            // 5. Update or Create (Using SLUG as the unbreakable anchor)
            const search = await strapiRequest(`articles?filters[slug][$eq]=${encodeURIComponent(slug)}`);
            
            if (search.data && search.data.length > 0) {
                // Strapi v5 FIX: Use documentId instead of id
                const targetId = search.data[0].documentId || search.data[0].id; 
                console.log(`Updating existing article (ID/DocID: ${targetId})...`);
                await strapiRequest(`articles/${targetId}`, 'PUT', payload);
                console.log(`✅ Updated successfully!`);
            } else {
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