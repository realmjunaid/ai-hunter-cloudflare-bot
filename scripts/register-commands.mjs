// One-time setup: registers /free, /run, /watch with Discord.
// Run locally (token never leaves your machine, never goes in chat/files):
//   $env:DISCORD_APPLICATION_ID='<app id>'; $env:DISCORD_BOT_TOKEN='<bot token>'; npm run register-commands
const APP_ID = process.env.DISCORD_APPLICATION_ID;
const TOKEN = process.env.DISCORD_BOT_TOKEN;
if (!APP_ID || !TOKEN) {
  console.error("Set DISCORD_APPLICATION_ID and DISCORD_BOT_TOKEN env vars first.");
  process.exit(1);
}

const commands = [
  { name: "free", description: "Ekhon kon free model ache (OpenRouter / Infron / Zen)" },
  { name: "run", description: "Ekhoni check chalao" },
  {
    name: "watch",
    description: "X accounts watch list",
    options: [
      { type: 1, name: "list", description: "Watched X accounts dekho" },
      {
        type: 1,
        name: "add",
        description: "Notun X account add koro",
        options: [
          {
            type: 3,
            name: "handle",
            description: "X handle, @ chara (e.g. OpenRouter)",
            required: true,
          },
        ],
      },
    ],
  },
];

const res = await fetch(
  `https://discord.com/api/v10/applications/${APP_ID}/commands`,
  {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: `Bot ${TOKEN}` },
    body: JSON.stringify(commands),
  },
);
if (!res.ok) {
  console.error("Register failed:", res.status, await res.text());
  process.exit(1);
}
console.log("Registered:", (await res.json()).map((c) => `/${c.name}`).join(", "));
