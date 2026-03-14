const fs = require('fs');
const path = require('path');
const matter = require('gray-matter');

const STRAPI_URL = process.env.STRAPI_URL;
const STRAPI_TOKEN = process.env.STRAPI_WRITE_TOKEN;

// Helper to interact with Strapi
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

async function runPublisher() {
    console.log("🚀 Starting Auto-Publisher...");

    // 1. Map String Names to Strapi IDs
    console.log("Fetching Categories and Tags from CMS...");
    const categoryData = await strapiRequest('categories');
    const tagData = await strapiRequest('tags');
    
    const categoryMap = {};
    categoryData.data.forEach(c => categoryMap[c.attributes.name] = c.id);
    
    const tagMap = {};
    tagData.data.forEach(t => tagMap[t.attributes.name] = t.id);

    // 2. Read Submissions
    const submissionsDir = path.join(__dirname, 'content', 'submissions');
    const files = fs.readdirSync(submissionsDir).filter(f => f.endsWith('.md'));

    for (const file of files) {
        console.log(`\n📄 Processing: ${file}`);
        const content = fs.readFileSync(path.join(submissionsDir, file), 'utf8');
        const parsed = matter(content);
        
        const { title, author, category, tags } = parsed.data;

        // Guardrail: Check required fields
        if (!title || !author || !category) {
            console.error(`❌ Skipped: Missing required frontmatter in ${file}`);
            continue;
        }

        // Map Category & Tags to IDs
        const categoryId = categoryMap[category];
        const tagIds = (tags || []).map(t => tagMap[t]).filter(id => id);

        const payload = {
            data: {
                title: title,
                content: parsed.content,
                // Note: If you have an 'author' text field in Strapi, uncomment the next line
                // author: author, 
                category: categoryId,
                tags: tagIds
            }
        };

        try {
            // Guardrail: Check if Article already exists (to Update instead of Create)
            const search = await strapiRequest(`articles?filters[title][$eq]=${encodeURIComponent(title)}`);
            
            if (search.data && search.data.length > 0) {
                const articleId = search.data[0].id;
                console.log(`Updating existing article (ID: ${articleId})...`);
                await strapiRequest(`articles/${articleId}`, 'PUT', payload);
                console.log(`✅ Updated successfully!`);
            } else {
                console.log(`Creating new article...`);
                await strapiRequest('articles', 'POST', payload);
                console.log(`✅ Created successfully!`);
            }
        } catch (error) {
            console.error(`❌ Failed to publish ${file}:`, error.message);
        }
    }
}

runPublisher();