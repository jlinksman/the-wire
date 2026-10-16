// The Wire — build timer. GitHub's own scheduler runs the 15-minute build hours late,
// so this Cloudflare Worker starts it on time through GitHub's workflow-dispatch API.
// It has no public page: workers.dev is disabled in wrangler.toml.
export default {
  async scheduled(event, env, ctx) {
    const res = await fetch(
      `https://api.github.com/repos/${env.REPO}/actions/workflows/build.yml/dispatches`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.GH_TOKEN}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "the-wire-build-timer",
        },
        body: JSON.stringify({ ref: "main" }),
      },
    );
    if (res.status !== 204) {
      // Shows up in the Worker's logs in the Cloudflare dashboard.
      throw new Error(`dispatch failed: HTTP ${res.status} ${await res.text()}`);
    }
  },
};
