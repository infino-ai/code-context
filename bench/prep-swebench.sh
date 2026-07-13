#!/bin/sh
# Download SWE-bench_Verified, filter to the standard protocol subset
# (15-60 min difficulty, exactly two modified .py files), clone the repos
# (bare, blob-filtered), and create a worktree per instance at its base
# commit. Everything lands under bench/.work/.
set -e
cd "$(dirname "$0")"
mkdir -p .work/repos .work/instances .work/results

python3 - <<'EOF'
import json, re, urllib.request, os
rows = []
offset = 0
while offset < 500:
    url = f'https://datasets-server.huggingface.co/rows?dataset=princeton-nlp%2FSWE-bench_Verified&config=default&split=test&offset={offset}&length=100'
    with urllib.request.urlopen(url) as r:
        rows.extend(x['row'] for x in json.load(r)['rows'])
    offset += 100

def patch_files(p):
    return sorted(set(re.findall(r'^diff --git a/(\S+)', p, re.M)))

cand = []
for r in rows:
    files = patch_files(r['patch'])
    if r['difficulty'] == '15 min - 1 hour' and len(files) == 2:
        cand.append({'id': r['instance_id'], 'repo': r['repo'], 'base': r['base_commit'],
                     'gold': files, 'problem': r['problem_statement']})
json.dump(cand, open('.work/instances.json', 'w'), indent=1)
print(len(cand), 'instances')
EOF

python3 - <<'EOF' > .work/prep-list.txt
import json
for c in json.load(open('.work/instances.json')):
    print(c['id'], c['repo'].replace('/', '__'), c['repo'], c['base'])
EOF

while read id name repo base; do
  [ -d ".work/repos/$name" ] || git clone --bare --filter=blob:none "https://github.com/$repo.git" ".work/repos/$name"
  if [ ! -d ".work/instances/$id/repo" ]; then
    mkdir -p ".work/instances/$id"
    git -C ".work/repos/$name" worktree add --detach "../../instances/$id/repo" "$base" \
      && echo "ok $id" || echo "FAIL $id"
  fi
done < .work/prep-list.txt
