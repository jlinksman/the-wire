#!/usr/bin/env bash
# The public KV namespace (2026-10-25): holds only the Ballot Match on/off switch (share.json).
# The public wire-ballot project is bound to this namespace and nothing else, so it can never
# reach the private one that holds Joe's answers. Finds or creates it, masks its ID, and
# exports PUBLIC_KV_ID for the next steps. Copies the switch over once if it isn't there yet.
set -euo pipefail
api="https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/storage/kv/namespaces"
auth=(-H "Authorization: Bearer $CLOUDFLARE_API_TOKEN")
id=$(curl -sf "${auth[@]}" "$api?per_page=100" | python3 -c "import sys,json; print(next((n['id'] for n in json.load(sys.stdin)['result'] if n['title']=='wire-public'),''))")
if [ -z "$id" ]; then
  id=$(curl -sf "${auth[@]}" -H "content-type: application/json" -X POST "$api" -d '{"title":"wire-public"}' | python3 -c "import sys,json; print(json.load(sys.stdin)['result']['id'])")
  echo "Created the public namespace."
fi
echo "::add-mask::$id"
echo "PUBLIC_KV_ID=$id" >> "$GITHUB_ENV"
if ! curl -sf "${auth[@]}" "$api/$id/values/share.json" >/dev/null; then
  v=$(curl -sf "${auth[@]}" "$api/$WIRE_KV_ID/values/share.json" || echo '{"on":false}')
  curl -sf "${auth[@]}" -X PUT "$api/$id/values/share.json" --data-binary "$v" >/dev/null
  echo "Switch copied to the public namespace."
fi
echo "Public namespace ready (holds only the on/off switch)."
