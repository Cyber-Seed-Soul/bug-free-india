const fs = require('fs');
const path = require('path');
const matter = require('gray-matter');

const authorsDir = path.join(process.cwd(), 'authors');
let hasError = false;

function logError(targetPath, message) {
    console.error(`❌ [REJECTED] ${targetPath}: ${message}`);
    hasError = true;
}

console.log("🛡️ STARTING GITOPS BOUNCER VALIDATION (SHARD AWARE)...\n");

// 1. Loop through Shards (e.g., 'a', 'b', 'p', 's')
const shards = fs.readdirSync(authorsDir);

for (const shard of shards) {
    if (shard === '_templates' || shard.startsWith('.')) continue;

    const shardPath = path.join(authorsDir, shard);
    if (!fs.statSync(shardPath).isDirectory()) continue;

    // 2. Loop through Authors in the Shard (e.g., 'pirateproprivate')
    const authors = fs.readdirSync(shardPath);
    for (const author of authors) {
        if (author.startsWith('.')) continue;

        const authorPath = path.join(shardPath, author);
        if (!fs.statSync(authorPath).isDirectory()) continue;

        // 3. Loop through Articles for the Author (e.g., 'pirate-post')
        const articles = fs.readdirSync(authorPath);
        for (const item of articles) {
            if (item === 'author.json' || item.startsWith('.')) continue;

            const articlePath = path.join(authorPath, item);
            if (!fs.statSync(articlePath).isDirectory()) {
                logError(articlePath, `Loose file found. Articles must be inside their own specific folder.`);
                continue;
            }

            const mdPath = path.join(articlePath, 'index.md');
            if (!fs.existsSync(mdPath)) {
                logError(articlePath, `Missing the required 'index.md' file.`);
                continue;
            }

            // 4. Validate Markdown Schema
            try {
                const contentRaw = fs.readFileSync(mdPath, 'utf8');
                const parsed = matter(contentRaw);
                const data = parsed.data;

                if (!data.title) logError(mdPath, `Missing 'title' in frontmatter.`);
                if (!data.slug) logError(mdPath, `Missing 'slug' in frontmatter.`);
                if (!data.category) logError(mdPath, `Missing 'category' in frontmatter.`);
                
                // 5. Validate Image Paths (Allow local or GitHub CDN)
                const imageRegex = /!\[([^\]]*)\]\(([^)]+)\)/g;
                const matches = [...parsed.content.matchAll(imageRegex)];
                for (const match of matches) {
                    const imagePath = match[2];
                    if (imagePath.startsWith('http')) {
                        if (!imagePath.includes('github.com') && !imagePath.includes('githubusercontent.com')) {
                            logError(mdPath, `Contains external image '${imagePath}'. Drag and drop images into GitHub directly.`);
                        }
                    } else if (!imagePath.startsWith('./images/') && !imagePath.startsWith('../')) {
                        logError(mdPath, `Image path '${imagePath}' is invalid.`);
                    }
                }
            } catch (e) {
                logError(mdPath, `Failed to parse Markdown or Frontmatter: ${e.message}`);
            }
        }
    }
}

if (hasError) {
    console.log("\n🚨 VALIDATION FAILED. Pull Request will be blocked.");
    process.exit(1);
} else {
    console.log("\n✅ ALL FOLDERS PASSED. Mathematical perfection achieved.");
    process.exit(0);
}