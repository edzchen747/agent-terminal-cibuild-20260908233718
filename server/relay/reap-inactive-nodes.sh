#!/bin/sh
set -eu

apk add --no-cache coreutils curl jq >/dev/null

api_key="${HEADSCALE_REAPER_API_KEY:-}"
base_url="${HEADSCALE_INTERNAL_URL:-http://headscale:8080}"
inactive_days="${NODE_INACTIVITY_DAYS:-30}"
interval="${NODE_REAPER_INTERVAL_SECONDS:-3600}"

if [ -z "$api_key" ]; then
  echo "node-reaper: HEADSCALE_REAPER_API_KEY is empty; inactivity expiry is disabled" >&2
  while :; do sleep "$interval"; done
fi

while :; do
  cutoff="$(date -u -d "-$inactive_days days" +%s 2>/dev/null || true)"
  if [ -n "$cutoff" ]; then
    nodes="$(curl -fsS -H "Authorization: Bearer $api_key" "$base_url/api/v1/node" || true)"
    if [ -n "$nodes" ]; then
      echo "$nodes" | jq -r '(.nodes // .)[] | [(.id // .nodeId), (.lastSeen // .lastSeenAt // .last_seen)] | @tsv' |
        while IFS="	" read -r node_id last_seen; do
          [ -n "$node_id" ] || continue
          [ -n "$last_seen" ] || continue
          last_epoch="$(date -u -d "$last_seen" +%s 2>/dev/null || echo 0)"
          if [ "$last_epoch" -gt 0 ] && [ "$last_epoch" -lt "$cutoff" ]; then
            curl -fsS -X POST -H "Authorization: Bearer $api_key" "$base_url/api/v1/node/$node_id/expire" >/dev/null ||
              echo "node-reaper: failed to expire node $node_id" >&2
          fi
        done
    fi
  fi
  sleep "$interval"
done
