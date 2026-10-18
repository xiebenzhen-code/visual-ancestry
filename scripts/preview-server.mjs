process.argv[2] = "dist";
process.argv[3] = process.argv[3] || "4173";
await import("./server.mjs");