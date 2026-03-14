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

async function runPublisher() {
    console.log("🚀 Starting Auto-Publisher...");
    let hasError = false;

    // 1. Fetch CMS Map
    const categoryData = await strapiRequest('categories');
    const tagData = await strapiRequest('tags');
    
    const categoryMap = {};
    categoryData.data.forEach(c => categoryMap[c.name || c.attributes?.name] = c.id);
    const tagMap = {};
    tagData.data.forEach(t => tagMap[t.name || t.attributes?.name] = t.id);

    // 2. Read Submissions
    const submissionsDir = path.join(__dirname, 'content', 'submissions');
    const files = fs.readdirSync(submissionsDir).filter(f => f.endsWith('.md'));

    for (const file of files) {
        console.log(`\n📄 Processing: ${file}`);
        const content = fs.readFileSync(path.join(submissionsDir, file), 'utf8');
        const parsed = matter(content);
        const { title, author, category, tags } = parsed.data;

        if (!title || !author || !category) {
            console.error(`❌ Skipped: Missing required frontmatter in ${file}`);
            hasError = true;
            continue;
        }

        // Auto-generate slug
        const generatedSlug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)+/g, '');

        // Use exact capitalization matching your Strapi database fields
        const payload = {
            data: {
                Title: title,             // Capital T
                slug: generatedSlug,
                Content: parsed.content,  // Capital C
                category: categoryMap[category],
                tags: (tags || []).map(t => tagMap[t]).filter(id => id),
                publishedAt: new Date().toISOString()
            }
        };

        try {
            // Use Capital 'Title' in the filter query
            const search = await strapiRequest(`articles?filters[Title][$eq]=${encodeURIComponent(title)}`);
            
            if (search.data && search.data.length > 0) {
                console.log(`Updating existing article (ID: ${search.data[0].id})...`);
                await strapiRequest(`articles/${search.data[0].id}`, 'PUT', payload);
                console.log(`✅ Updated successfully!`);
            } else {
                console.log(`Creating new article...`);
                await strapiRequest('articles', 'POST', payload);
                console.log(`✅ Created successfully!`);
            }
        } catch (error) {
            console.error(`❌ Failed to publish ${file}:`, error.message);
            hasError = true;
        }
    }

    if (hasError) process.exit(1); // Force GitHub Action to turn RED if anything fails
}

runPublisher();