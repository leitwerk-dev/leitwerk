import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";

export default defineConfig({
	plugins: [svelte()],
	resolve: { conditions: ["source", "browser"] },
	server: { host: "127.0.0.1", port: 4320, strictPort: true },
});
