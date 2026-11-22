// Shows which host was blocked. Kept in its own file because extension pages
// (Manifest V3) block inline <script> tags.
const params = new URLSearchParams(location.search);
const host = params.get("host") || "this site";
document.getElementById("host").textContent = host;
document.title = "🎯 " + host + " is blocked";
