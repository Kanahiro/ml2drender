# MapLibre style 2D タイルレンダラ (Rust / WASM)

セッション開始時に必ず `STATUS.md` を読むこと(通過率・未対応機能・既知の問題・次フェーズの前提)。

## 目的

MapLibre style (style-spec JSON) を**タイルベースの2D表現に限って**仕様準拠でレンダリングする最小のレンダラ。主ターゲットは `wasm32-unknown-unknown`(Cloudflare Workers / Deno / WASI / ブラウザ)。GPU・ネイティブバイナリなしで静止画(RGBA)を返せることが価値。

「完璧」の定義: **対象レイヤについて maplibre-gl-js の render-tests が許容差内で通ること**。ピクセル完全一致は目指さない(GPU vs tiny-skia の差)。

前提を忘れないこと: 正確さだけが目的なら MapLibre Native(ヘッドレス可)を使うほうが安い。本プロジェクトの価値は「GPU不要・軽量・WASM・サーバレス」。

## スコープ

対象:
- style-spec のパース(serde)と式(expression)評価
- ソース: vector(MVT), raster, geojson, image
- 投影: Web Mercator のみ。カメラは center / zoom / bearing(2D 回転)
- レイヤ: background / fill / line / circle / raster / symbol(段階的)
- sprite(fill-pattern, line-pattern, icon)、glyph(SDF PBF)

非対象(手を出さない): fill-extrusion / 3D / pitch / terrain / globe・非mercator投影 / sky / light、実行時のスタイル・カメラ変更(setPaintProperty / setStyle / setFeatureState 等。render テストの `operations` は wait 系以外を含めば skip)、ネットワーク取得・キャッシュ・PMTiles 読み出し(ホストの責務)。

## 設計制約(厳守)

- **純Rustのみ。C依存禁止**(zstd, freetype, harfbuzz, GDAL 等は不可)。依存クレートは採用前に `cargo build -p mlrender --target wasm32-unknown-unknown` で確認する。
- **API の最小形は「style.json + XYZ → タイル画像」**: `Renderer::new(style, View::tile(z, x, y, tile_size))`。`View`(center/zoom/bearing/サイズ/pixel_ratio)は任意カメラ用の一般形で、render テストはこちらを使う。スタイルは生成時に固定(変更 API は作らない)。
- **Sans-IO**: `core` は fetch / ファイル / async / スレッド / 時計に依存しない。`Renderer` が:
  - `needs() -> Vec<Resource>`: 現時点で必要な未取得リソース(tile / glyph range / sprite json / sprite png / TileJSON など)
  - `provide(url, Option<bytes>)`: 取得済みバイト列を渡す(`None` = 取得失敗/404)
  - `render() -> RGBA`: `needs()` が空のときのみ呼べる
- 必要リソースは**段階的に確定する**(タイル取得 → MVTデコードと式評価でテキスト確定 → glyph range 確定)。ホストは `needs()` が空になるまで取得と `provide()` を繰り返す。1往復で済む前提の設計にしない。
- 単一スレッド。並列化しない。
- 採用済みクレート(すべて純 Rust・wasm32 確認済み): `serde_json`, `indexmap`, `unicode-normalization`, `earcutr`, `miniz_oxide`, `png`, `zune-jpeg`, `image-webp`。描画は自前のソフトウェア GL(tiny-skia は不採用: GL の AA・合成規則と一致させるため)。
- テキストは SDF グリフを自前でしきい値処理して合成(halo / text-opacity もこの層)。MapLibre は HarfBuzz を使わず PBF グリフのメトリクスで自前レイアウトしているので、`shaping` / `placement` のアルゴリズムを再現する。RTL 等は後回し。

## 構成

- `core/` — crate `mlrender`。純粋ロジック(sans-IO)。
  - `expression/` — style-spec 式の移植(パース・型検査・評価)、`function.rs` は実行時の legacy function。
  - `style/` — レイヤ・プロパティのコンパイル、フィルタ。`spec.json` は v8.json の必要部分(`scripts/trim-spec.ts` で生成)。
  - `mvt.rs`(MVT デコード、overzoom 分割)、`geojson.rs`(geojson-vt 移植)、`tile.rs`(Transform・タイル被覆・URL)、`image.rs`(画像デコード・GL 風テクスチャ)、`sprite.rs`(sprite 読み込み)。
  - `render/` — `raster.rs` がソフトウェア GL(三角形・GL ライン・合成・マスク)、`mod.rs` / `line.rs` / `raster_layer.rs` / `pattern.rs` が各レイヤのバケット生成とシェーダ再現。
  - 方針: MapLibre の **バケット生成とシェーダをそのまま移植**し、GL と同じ規則でラスタライズする(tiny-skia は使わない)。上流の量子化・桁あふれ等の癖も再現する。
- `cli/` — crate `mlrender-cli`、バイナリ `mlrender`。テストランナー兼ネイティブ検証用。
- `wasm/` — crate `mlrender-wasm`。wasm-bindgen なしの素の C-ABI export(`renderer_new/needs/provide/render/free`, `alloc/dealloc`, 結果は `out_ptr/out_len` の共有バッファ)。
- `examples/browser/` — pnpm パッケージ `demo-browser`(Vite + TypeScript、maplibre-gl は npm 依存)。左に MapLibre GL JS(参照)、右に WASM 出力。`needs`→fetch→`provide` ループのホスト実装例を兼ねる。wasm は `target/` から `?url` import(Vite の fs.allow はワークスペースルートまで既定で許可)。社内標準のフロントエンド既定は SvelteKit だが、1画面の検証用ツールなので素の Vite にしている。
- `tests/exclusions.json` — 対象外 render テストの除外ルール(理由付き)。pitch/roll/非mercator/operations はランナー内にハードコード。
- `fixtures/` — 上流テスト(gitignore)。`scripts/fetch-fixtures.sh` が固定コミットから取得し LICENSE を同梱する。

## コマンド

全体を pnpm で管理する(`package.json` の scripts が cargo を包む)。Node は `.node-version`(26, Active LTS)、pnpm は `packageManager` で固定。`pnpm-workspace.yaml` で `minimumReleaseAge: 10080`(公開7日未満の版は入れない)。JS は TypeScript のみ(`.js` を新規に作らない)。

```sh
pnpm install
pnpm fixtures                      # 初回のみ(~144MB)
pnpm test                          # cargo test
pnpm test:render [filter]          # → target/test-report/render/{summary.md,results.json,<id>/diff.png}
pnpm test:expression [filter]      # → target/test-report/expression/{summary.md,failures.json}
pnpm demo                          # wasm ビルド + Vite dev server(examples/browser)
pnpm typecheck                     # tsc --noEmit(全パッケージ)
./target/release/mlrender compare a.png b.png [threshold]
```

比較は maplibre-gl-js と同じ: pixelmatch 8.0.0 の移植(`cli/src/pixelmatch.rs`、JS版と300組で一致確認済み)、`threshold` 既定 0.1285、`allowed`(不一致画素率)既定 0.00025、テストごとの `metadata.test` 指定があればそれに従う。`expected*.png` が複数あれば最小差分を採用。expression は上流と同じく数値を有効数字6桁で比較。

## ルール

- **テスト特化のハードコード、特定ケースへの分岐は禁止。** 仕様に基づく実装のみ。通らないケースは通らないまま `STATUS.md` に理由付きで記録する。
- 各フェーズ末に `STATUS.md` を更新する(通過率、未対応機能一覧、既知の問題、次フェーズの前提)。
- 差が大きい失敗(アンチエイリアスやジョイン形状以外)は個別に原因を調査する。

## フェーズ計画(1フェーズ=1セッション目安)

1. ワークスペース骨格 + テスト取り込み + ランナー + 通過率レポート ✅
2. style-spec パース + 式評価(expression テスト通過率を上げる。型システム、match/case/interpolate/step/format/number-format など) ✅
3. MVT デコード + background / fill / line / circle(line-join/cap、dasharray、タイル境界バッファ、overzoom) ✅
4. raster + sprite(fill-pattern / line-pattern) ✅
5. sans-IO API の確定 + WASMビルド + JSホストのサンプル(`needs`→fetch→`provide` ループ、サイズ計測)。デモ画面 `examples/browser/` は先行して作成済み、各フェーズで目視確認に使う
6. symbol: 水平な点ラベル → アイコン → line placement → CJK / 縦書き(衝突検出は画面単位)

**フェーズ5完了時点で人間がレビューする。** 特に `needs()` の段階的依存設計を確認してから 6 に入ること。

## 既知のリスク

- symbol が工数の大半。最後に回し、未対応範囲を `STATUS.md` に明示する。
- アンチエイリアスやジョイン形状は MapLibre(GPU)と差が出る。許容差で吸収し、差が大きいものは個別に調査。
- WASM のサイズと速度: simd128、`opt-level="z"`、`wasm-opt` を検討。単一スレッドでネイティブの1.5〜2倍遅い程度を想定。
