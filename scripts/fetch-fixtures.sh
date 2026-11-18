#!/bin/sh
# Fetch upstream test fixtures (BSD-3, see fixtures/LICENSE-*.txt) at pinned commits into fixtures/.
set -eu
GL_JS_COMMIT=eea5999bb1fa7dcfc0355a4e8836467c73213946
STYLE_SPEC_COMMIT=f5708a944ac65d46620a649b2edaa51eed719b3e
# Remote resources that render tests fetch from the network upstream (served as fixtures/render/remote/<host>/).
DEMOTILES_COMMIT=601ae60796ceceda2cbd2ed3d2ea92d17a84be4b # gh-pages = https://demotiles.maplibre.org/

root=$(cd "$(dirname "$0")/.." && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

fetch() { # repo commit sparse-paths...
  repo=$1 commit=$2; shift 2
  git -C "$tmp" init -q "$repo"
  git -C "$tmp/$repo" remote add origin "https://github.com/maplibre/$repo.git"
  git -C "$tmp/$repo" sparse-checkout set --no-cone "$@" LICENSE.txt LICENSE
  git -C "$tmp/$repo" fetch -q --depth 1 --filter=blob:none origin "$commit"
  git -C "$tmp/$repo" checkout -q FETCH_HEAD
}

fetch maplibre-gl-js "$GL_JS_COMMIT" /test/integration/render/tests /test/integration/assets
fetch maplibre-style-spec "$STYLE_SPEC_COMMIT" /test/integration/expression/tests
fetch demotiles "$DEMOTILES_COMMIT" "/font/Open Sans Regular,Arial Unicode MS Regular/0-255.pbf"

rm -rf "$root/fixtures"
mkdir -p "$root/fixtures/render/remote/demotiles.maplibre.org" "$root/fixtures/expression"
mv "$tmp/maplibre-gl-js/test/integration/render/tests" "$root/fixtures/render/tests"
mv "$tmp/maplibre-gl-js/test/integration/assets" "$root/fixtures/render/assets"
mv "$tmp/maplibre-style-spec/test/integration/expression/tests" "$root/fixtures/expression/tests"
cp "$tmp/maplibre-gl-js/LICENSE.txt" "$root/fixtures/LICENSE-maplibre-gl-js.txt"
mv "$tmp/demotiles/font" "$root/fixtures/render/remote/demotiles.maplibre.org/"
cp "$tmp/maplibre-style-spec/LICENSE.txt" "$root/fixtures/LICENSE-maplibre-style-spec.txt"
cp "$tmp/demotiles/LICENSE" "$root/fixtures/LICENSE-demotiles.txt"
printf 'maplibre-gl-js %s\nmaplibre-style-spec %s\ndemotiles %s\n' "$GL_JS_COMMIT" "$STYLE_SPEC_COMMIT" "$DEMOTILES_COMMIT" > "$root/fixtures/VERSION"
echo "fixtures ready: $(find "$root/fixtures/render/tests" -name style.json | wc -l) render, $(find "$root/fixtures/expression/tests" -name test.json | wc -l) expression"
