const fs = require('fs');
const path = require('path');
const matter = require('gray-matter');

const authorsDir = path.join(process.cwd(), 'authors');
let hasError = false;

function logError(author, message) {
    console.error(`❌ [REJECTED] Author '${author}': ${message}`);
    hasError = true;
}

console.log("🛡️ STARTING GITOPS BOUNCER VALIDATION...\n");

const authors = fs.readdirSync(authorsDir);

for (const author of authors) {
    // Skip the templates folder and hidden files
    if (author === '_templates' || author.startsWith('.')) continue;

    const authorPath = path.join(authorsDir, author);
    if (!fs.statSync(authorPath).isDirectory()) continue;

    // 1. Validate Optional Author JSON
    const authorJsonPath = path.join(authorPath, 'author.json');
    if (fs.existsSync(authorJsonPath)) {
        try {
            const authorData = JSON.parse(fs.readFileSync(authorJsonPath, 'utf8'));
            if (!authorData.name) logError(author, `author.json is missing the required 'name' field.`);
        } catch (e) {
            logError(author, `author.json contains invalid JSON syntax.`);
        }
    }

    // 2. Validate Articles
    const articles = fs.readdirSync(authorPath);
    for (const item of articles) {
        const articlePath = path.join(authorPath, item);
        
        // Skip author.json at the root of their folder
        if (item === 'author.json') continue;

        if (!fs.statSync(articlePath).isDirectory()) {
            logError(author, `Found loose file '${item}'. Articles must be inside their own specific folder.`);
            continue;
        }

        const mdPath = path.join(articlePath, 'index.md');
        if (!fs.existsSync(mdPath)) {
            logError(author, `Folder '${item}' is missing the required 'index.md' file.`);
            continue;
        }

        // 3. Validate Frontmatter Schema
        const contentRaw = fs.readFileSync(mdPath, 'utf8');
        const parsed = matter(contentRaw);
        const data = parsed.data;

        if (!data.title) logError(author, `Article '${item}' is missing 'title' in frontmatter.`);
        if (!data.slug) logError(author, `Article '${item}' is missing 'slug' in frontmatter.`);
        if (!data.category) logError(author, `Article '${item}' is missing 'category' in frontmatter.`);
        if (!data.date) logError(author, `Article '${item}' is missing 'date' in frontmatter.`);
        
        // 4. Validate Image Paths (No absolute URLs, no external hosting, strictly local relative paths)
        const imageRegex = /!\[([^\]]*)\]\(([^)]+)\)/g;
        const matches = [...parsed.content.matchAll(imageRegex)];
        for (const match of matches) {
            const imagePath = match[2];
            if (imagePath.startsWith('http')) {
                logError(author, `Article '${item}' contains external image link '${imagePath}'. Images must be hosted locally in your images/ folder.`);
            } else if (!imagePath.startsWith('./images/')) {
                logError(author, `Article '${item}' image path '${imagePath}' is invalid. It must start with './images/'.`);
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