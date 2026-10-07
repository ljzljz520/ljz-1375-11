#!/usr/bin/env bash
# End-to-end HTTP acceptance scenarios. Usage: bash tests/http_scenarios.sh
set -u
BASE="http://localhost:${PORT:-8020}"
pass=0; fail=0
check(){ if [ "$2" = "$3" ]; then pass=$((pass+1)); echo "PASS $1";
  else fail=$((fail+1)); echo "FAIL $1 (got '$2' want '$3')"; fi; }

J(){ curl -s -H 'Content-Type: application/json' "$@"; }
JP(){ curl -s -X POST -H 'Content-Type: application/json' "$@"; }

# 公告先到活动后到
JP -d '{"external_ref":"E2E-2030","title":"2030公告先行","announced_at":"2030-01-01T09:00:00","timezone":"Asia/Shanghai","occurrences":[{"slug":"e2e-2030","start_local":"2030-02-10T10:00:00","end_local":"2030-02-10T20:00:00","original_expression":"原文日期2030-02-10"}]}' $BASE/api/announcements >/dev/null
st=$(J $BASE/api/instances | python3 -c "import json,sys;print([i['status'] for i in json.load(sys.stdin) if i['slug']=='e2e-2030'][0])")
check "announcement-first auto-confirms" "$st" "confirmed"

# 节点下线
nid=$(J $BASE/api/nodes | python3 -c "import json,sys;print([n['id'] for n in json.load(sys.stdin) if n['slug']=='city-wall'][0])")
ver=$(J $BASE/api/nodes | python3 -c "import json,sys;print([n['version'] for n in json.load(sys.stdin) if n['slug']=='city-wall'][0])")
curl -s -X PUT -H "If-Match: $ver" -H 'Content-Type: application/json' -d '{}' $BASE/api/nodes/$nid/offline >/dev/null
feas=$(JP -d '{"origin":"east-gate","dest":"city-wall","start_local":"2027-02-20T16:30:00","candidate_edges":["eg-bp-walk","bp-ss-walk","ss-cw"]}' $BASE/api/routes/compare | python3 -c "import json,sys;print(json.load(sys.stdin)['candidate']['feasible'])")
check "offline node makes candidate infeasible" "$feas" "False"
# restore for other checks
ver2=$((ver+1))
curl -s -X PUT -H "If-Match: $ver2" -H 'Content-Type: application/json' -d '{"status":"online"}' $BASE/api/nodes/$nid >/dev/null

# 两人并发改连线 => 第二者 409
eid=$(J $BASE/api/edges | python3 -c "import json,sys;print([e['id'] for e in json.load(sys.stdin) if e['slug']=='metro-bp'][0])")
curl -s -X PUT -H 'If-Match: 1' -H 'X-Actor: A' -H 'Content-Type: application/json' -d '{"from_slug":"metro-zhonglou","to_slug":"bell-plaza"}' $BASE/api/edges/$eid/reconnect >/dev/null
code=$(curl -s -o /dev/null -w '%{http_code}' -X PUT -H 'If-Match: 1' -H 'X-Actor: B' -H 'Content-Type: application/json' -d '{"from_slug":"metro-zhonglou","to_slug":"south-square"}' $BASE/api/edges/$eid/reconnect)
check "concurrent reconnect -> 409" "$code" "409"

# 发布冻结：发布后新增节点不出现在缓存年历
JP -d '{"title":"E2E发布","year":2027}' $BASE/api/publications >/dev/null
JP -d '{"slug":"e2e-late","name":"发布后才加的节点","kind":"ceremony"}' $BASE/api/nodes >/dev/null
in_cache=$(J $BASE/api/almanac/2027 | python3 -c "import json,sys;print(any(n['slug']=='e2e-late' for n in json.load(sys.stdin)['nodes']))")
check "cached almanac excludes late node" "$in_cache" "False"
in_live=$(J "$BASE/api/almanac/2027?live=1" | python3 -c "import json,sys;print(any(n['slug']=='e2e-late' for n in json.load(sys.stdin)['nodes']))")
check "live view includes late node" "$in_live" "True"
JP -d '{"title":"E2E重发","year":2027}' $BASE/api/publications >/dev/null
in_cache2=$(J $BASE/api/almanac/2027 | python3 -c "import json,sys;print(any(n['slug']=='e2e-late' for n in json.load(sys.stdin)['nodes']))")
check "republish refreshes cache" "$in_cache2" "True"

# 同节点多路线引用
shared=$(python3 - "$BASE" <<'PY'
import json,sys,urllib.request
base=sys.argv[1]
routes=json.load(urllib.request.urlopen(base+'/api/routes'))
edges=set()
for r in routes:
    d=json.load(urllib.request.urlopen(base+'/api/routes/'+str(r['id'])))
    edges.update(d['edge_slugs'])
print(len(edges))
PY
)
[ "${shared:-0}" -ge 5 ] && { pass=$((pass+1)); echo "PASS routes reference $shared distinct edges"; } || { fail=$((fail+1)); echo "FAIL only $shared edges"; }

echo "---- $pass passed, $fail failed ----"
exit $fail
