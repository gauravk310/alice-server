import dns from "node:dns";

// Configure DNS to use public resolvers (Google / Cloudflare) to prevent Windows querySrv ECONNREFUSED on MongoDB Atlas
try {
  dns.setServers(["8.8.8.8", "1.1.1.1"]);
  dns.setDefaultResultOrder?.("ipv4first");
} catch (e) {
  // Ignore if not supported
}
