const fs = require('fs');
const matter = require('gray-matter');

// 1. Load the Truth Files
const validCategories = JSON.parse(fs.readFileSync('./categories.json', 'utf8'));
const validTags = JSON.parse(fs.readFileSync('./tags.json', 'utf8'));

// 2. Read the Markdown File
const fileContent = fs.readFileSync('./content/submissions/test-article.md', 'utf8');
const parsedFile = matter(fileContent);

console.log("--- Extracted Data ---");
console.log("Title:", parsedFile.data.title);
console.log("Category:", parsedFile.data.category);
console.log("Tags:", parsedFile.data.tags);

// 3. Mathematical Validation
console.log("\n--- Validation Check ---");
if (!validCategories.includes(parsedFile.data.category)) {
    console.log("❌ FAILED: Category '" + parsedFile.data.category + "' is not allowed!");
} else {
    console.log("✅ PASSED: Category is valid.");
}

const invalidTags = parsedFile.data.tags.filter(tag => !validTags.includes(tag));
if (invalidTags.length > 0) {
    console.log("❌ FAILED: Invalid tags found - " + invalidTags.join(", "));
} else {
    console.log("✅ PASSED: All tags are valid.");
}