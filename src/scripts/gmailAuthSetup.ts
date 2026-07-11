import { createServer } from "node:http";
import { URL } from "node:url";
import { createOAuthClient, saveToken, GMAIL_SCOPES } from "../connectors/gmailAuth.js";
import { config } from "../config.js";

async function main(): Promise<void> {
  const client = createOAuthClient();
  const authUrl = client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: GMAIL_SCOPES,
  });

  const redirect = new URL(config.google.redirectUri);
  const port = Number(redirect.port) || 80;

  console.log("\nOuvrez cette URL dans un navigateur connecte au compte Gmail a utiliser pour les tests:\n");
  console.log(authUrl);
  console.log("\nEn attente de l'autorisation...\n");

  const code = await new Promise<string>((resolve, reject) => {
    const server = createServer((req, res) => {
      if (!req.url) return;
      const url = new URL(req.url, `http://localhost:${port}`);
      const receivedCode = url.searchParams.get("code");
      const error = url.searchParams.get("error");

      if (error) {
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        res.end(`<p>Autorisation refusee: ${error}. Vous pouvez fermer cet onglet.</p>`);
        server.close();
        reject(new Error(`Autorisation refusee: ${error}`));
        return;
      }

      if (receivedCode) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end("<p>Autorisation recue. Vous pouvez fermer cet onglet et revenir au terminal.</p>");
        server.close();
        resolve(receivedCode);
      }
    });

    server.listen(port);
  });

  const { tokens } = await client.getToken(code);
  saveToken(tokens);
  console.log(`\nJeton enregistre dans ${config.google.tokenPath}`);
  console.log("Vous pouvez maintenant lancer: npm run dev\n");
}

main().catch((err) => {
  console.error("Echec de l'autorisation Gmail:", err);
  process.exit(1);
});
