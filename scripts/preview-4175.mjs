// Force the preview server onto 4175 regardless of shell env/args.
process.env.PORT = "4175";
process.argv[2] = "dist";
process.argv[3] = "4175";
await import("./server.mjs");