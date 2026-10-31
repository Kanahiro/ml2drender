# STATUS

最終更新: 2026-10-31(フェーズ2・3・4・6 完了。クラスタ・DEM・WASM最適化を現構成へ統合。PNG出力・Workersロード対応を追加。都会・高ズームの重複処理を削減。フェーズ5の人間レビューを経ずに、指示によりフェーズ6(symbol)を先行実施)

## スコープ決定(2026-10-31、人間判断)

- geojson / image ソースは対象。
- 実行時のスタイル・カメラ変更は対象外。`metadata.test.operations` に wait/idle/sleep/redraw 以外を含むテストは skip。
- API の最小形は「style.json + XYZ → タイル画像」(`View::tile`)。任意カメラは `View` で指定。
- 投影は mercator のみ。

## 通過率

Expression: **581 / 583(99.7%)**

Render: **pass 988 / fail 20 / skip 727**(in scope 1008 中 98.0%)。高ズームの再利用最適化後に全1735件を再実行。変更前と全件の判定・差分率が一致。

| layer type | pass | fail | skip | 通過率 |
|---|---|---|---|---|
| background | 406 | 7 | 357 | 98.3% |
| circle | 156 | 1 | 128 | 99.4% |
| fill | 131 | 2 | 90 | 98.5% |
| line | 206 | 2 | 80 | 99.0% |
| raster | 87 | 0 | 77 | 100.0% |
| symbol | 425 | 20 | 241 | 95.5% |
| hillshade | 49 | 0 | 12 | 100.0% |
| color-relief | 15 | 0 | 0 | 100.0% |
| heatmap | 38 | 0 | 6 | 100.0% |

(1テストは使用する全レイヤ種別に計上。fail 20 はすべて symbol レイヤを含むテスト。内訳は「未対応・既知の問題」)

## 実装済み

### 都会・高ズームの切り出し／マスク再利用 (2026-10-31)

- `tile.openstreetmap.jp/styles/openmaptiles/style.json` の東京駅周辺で調査。元データmaxzoom 14を超える描画で、同じMVTの切り出しとタイル境界マスクの生成をスタイルレイヤごとに繰り返していた。z16の計測では切り出し15,808回・約995ms、マスク150回・約324ms。
- 切り出し結果はソースごとに `(データタイルID, 描画先のcanonical ID)` で共有。glyph要求の計算と複数スタイルレイヤが同じ結果を利用する。world wrapはタイル内の座標を変えないため共有でき、異なるソース・切り出し先は混同しない。
- マスクの所有権は描画ごとに作る `render::Ctx` に置く。キーはフレームバッファ寸法と順序付きRenderTile集合（wrap含む）。親子タイルの被覆関係を保持し、カメラのクランプや次回描画のために手動でキャッシュを破棄する必要がない。
- 回帰テストは切り出しの共有・ソース／兄弟タイルの分離・元ズームへのクランプ、マスクの親子関係・順序・wrap・寸法、新しい描画コンテキストでの再投影を確認。Rust単体テスト32件成功。上流描画テスト全1735件は判定・差分率とも変更前と一致。
- 東京駅周辺、256 CSS px / DPR 2 / margin 64、取得済み素材でのNode/WASM中央値（ウォームアップ後5回）: z14 **643→333ms**、z16 **1591→224ms**、z18 **790→139ms**。各条件のPNGは変更前と完全一致。
- Chrome 156でz16を6組交互に測定し、中央値 **1469→214ms（約6.9倍）**、PNGのSHA-256一致を確認。ブラウザ本番ビルドとWrangler dry-run成功。最新WASMは約1.89 MB。記録: `target/benchmark/urban-openmaptiles/fixed-summary.json`（生成物、gitignore）。

### PNG出力・Cloudflare Workersロード (2026-10-31)

- Rust `Renderer::render_png()` とC ABI `renderer_render_png` を追加。既存の描画・margin切り出し後にRGBA8 PNGへ可逆圧縮し、共有出力バッファへ返す。純Rustの既存 `png` クレートを使用し、CPU時間を優先する `Compression::Fast` を選択。
- `MapRenderer.renderPng(view)` は独立した `Uint8Array<ArrayBuffer>` を返す。RGBAの `render()` とリソース取得・エラー処理を共有し、JSへのRGBA全体のコピーを挟まずPNGだけをコピーする。
- `MapRenderer.init(styleUrl, { wasm: WebAssembly.Module })` を追加。指定時は実行時のWASM取得・コンパイルを行わず、専用インスタンスを生成する。未指定のブラウザでは `new URL(..., import.meta.url)` のアセットを取得するため、公開APIからVite専用の `?url` importを除去。
- `ml2drender/renderer.wasm` を型定義付きで公開。WranglerがCompiledWasmとして認識できるよう、公開パスにも `.wasm` 拡張子を含める。
- `examples/workers/` にWranglerサンプルを追加。`pnpm demo:workers` でローカル起動し、`pnpm --filter demo-workers build` でデプロイせずバンドルを確認できる。コンパイル済みモジュールのみ共有し、リクエストごとにレンダラ・WASMメモリを作る。
- Rust単体テスト29件成功。半透明・小数DPR・marginのPNGラウンドトリップ、未取得リソースのエラーを確認。公開型・両サンプルの型チェック、Vite本番ビルド、Wrangler dry-run成功。
- ローカルworkerdで3並行リクエストのPNGレスポンス（Content-Type・PNG署名）を確認。ChromeでWorkers出力とRGBAの全画素一致、DPR 1 / 1.5 / 2 × margin 0 / 64 のPNG寸法・画素一致、既存Bitmap Workerを確認。モジュール注入時にWASM fetch・compileが呼ばれないこと、PNGバッファの保持、RGBA/PNG並行呼び出し、入力・スタイルのエラーも確認。
- WASMは1,880,411 bytes（約1.88 MB）。Cloudflare本番へのデプロイは行っていない。上記の上流描画・式評価テストの通過率はクラスタ統合時の全件実行結果。

### GeoJSONクラスタ・WASM最適化の統合 (2026-10-31)

- `995fc7e` の supercluster / kdbush、`clusterProperties` の map/reduce、GeoJSON ソース `filter` を現構成へ取り込み。ソース filter はクラスタ生成より前に適用し、非クラスタのソースにも適用する。
- クラスタ・集約プロパティ・ソースfilterの上流テスト3件が成功に変わり、描画テストは上記の通過率へ改善。単体テスト27件成功、式評価は581/583で変化なし。
- `713b451` の専用 `wasm` プロファイル（opt-level 3 / fat LTO / codegen-units 1 / panic abort / strip）と simd128 を取り込み。`pnpm build:wasm` は新プロファイルでビルドし、`target/wasm32-unknown-unknown/wasm/` の成果物を公開パッケージへコピーする。
- 最適化WASMは1,827,396 bytes（約1.83 MB）。型チェック・ブラウザ用本番ビルド成功。Chromeでクラスタ・集約プロパティ・ソースfilter・Hillshadeの各fixtureを margin 0 / 64 で描画し、Workerとメインで生成したBitmapの全画素一致を確認。
- 統合時に `phase6-symbol` のcore実装・WASM設定を再比較。機能の未取り込みは解消し、残る差は現在側の名称・配置・margin・追加テスト・インデント修正。JS API・Worker・デモは現在側の拡張を維持。

### DEM・Hillshade の復元 (2026-10-31)

- 別履歴の `54640b6` にあった `raster-dem` / hillshade / color-relief / heatmap の実装を、現在の `crates/` 構成へ復元。現ブランチではソース・描画処理・spec・テスト除外ルールが未反映で、JS API の対応レイヤ一覧と README だけが対応済みになっていた。
- DEM は mapbox / terrarium / custom encoding、TileJSON の tileSize・encoding、隣接タイルの境界補完、親タイルへのフォールバックに対応。既存の margin による切り出しを維持。
- DEM 取得から陰影描画までの回帰テストを追加し、margin 0 / 8 で確認。復元直後の Rust 単体テスト25件成功。現在の上流描画テスト結果は上記を参照。
- WASM 再ビルド済み。Chrome で上流の実DEMタイルを使い、margin 0 / 64 の両方で Worker の ImageBitmap と直接RGBA出力の全画素一致、陰影表示を確認。
- コピー削減・Worker 内 Bitmap 化を維持。受信側が破棄する Bitmap は `close()` する。

### 描画余白 (`margin`)

- `MapRenderer.render(view)` / Rust `View` に `margin` を追加（非負整数の CSS ピクセル、既定 0）。余白を含むタイル取得・symbol 配置・描画後に、元の出力サイズへ切り出す。WASM ABI の `renderer_new` にも引数を追加したため、ホストと WASM は一緒に更新する。
- 元のカメラ中心・ラスターのピクセル整列を保持。小数 DPR は余白をデバイスピクセルへ丸める。ブラウザデモは `margin: 64` CSS ピクセルを使用。
- 隣接タイルのアイコン、余白分のタイル取得、極域の中心維持、小数 DPR・回転時の射影とピクセル整列を単体テストで確認。margin はタイル間の独立した衝突判定による配置差を完全には解消しない。
- ブラウザデモの右側は MapLibre GL JS の raster ソースを使用。WASM Worker の生成画像を `addProtocol` 経由で `ImageBitmap` として渡し、左右の中心・ズームを同期。Leaflet 依存を削除。

### フェーズ2: 式評価(`crates/core/src/expression/`)

- style-spec `src/expression` の移植: 型システム、パース/型検査(エラーメッセージ・キーまで一致)、定数畳み込み、全演算子、`within` / `distance`、legacy function → expression 変換(テスト用)。
- JS 互換の細部: 数値の文字列化(`Number#toString`)、`JSON.stringify`、`Math.round`、`String()` 強制、UTF-16 順の文字列比較。
- 実行時の legacy function は upstream と同じく `createFunction` 相当(`expression/function.rs`)で評価する(変換版とは端の挙動が違う)。
- 失敗 2 件(`collator/variable-gt`, `collator/variable-lteq`): ロケール別照合(スウェーデン語の ä、ドイツ語 search 照合)が必要。照合はルート照合のみ・`resolved-locale` は英語以外 `en-US` に解決する設計上の制約。

### フェーズ3: MVT / GeoJSON + background / fill / line / circle

- **ソフトウェア GL**(`render/raster.rs`): MSAA なしの GL と同じく、画素中心サンプリングの三角形ラスタライズ + 各シェーダの AA 計算をそのまま再現。unorm8 のプリマルチプライド合成。tile clip は stencil 相当のマスク。
- MVT デコード(protobuf 手書き、gzip 対応)。GeoJSON は geojson-vt 移植(簡略化・buffer 付きクリップ・世界ラップ・rewind・量子化・lineMetrics)。
- LineBucket の移植(join/cap/miter/bevel/flipbevel/fakeround/sharp corner/line-offset)、dash(LineAtlas SDF)、line-gradient(color ramp テクスチャ)、`*-layer-opacity`(オフスクリーン合成)、translate、sort-key、overzoom。
- 上流の「実装上の癖」も再現している(これをやらないと一致しない):
  - extrude ベクトルを Uint8/Int8 属性に格納する際の桁あふれ(miter-limit が大きいと継ぎ目が欠ける)。
  - GL の top-left 規則は y-up 窓座標基準 → y-down バッファでは「左辺 + 下辺」を含む。
  - `linesofar` の 1/2 量子化と長い線での距離リセット。
  - MapLibre 5.x の overzoom タイル分割(`zoomLevelsToOverscale` = 4): maxzoom を超えて `map.maxZoom - 4` までは親タイルを切り出し、vt-pbf 再エンコード時の差分整数切り捨てまで再現。
  - 背景はワールドの縦範囲内のみ描画。`background-pattern` が設定されていて解決できなければ背景を描かない。
- WASM: 1.16 MB(未最適化)。demotiles を Node から wasm 経由で描画できることを確認(TileJSON → タイル 4 枚 → 66 ms)。

### フェーズ4: raster / image ソース / sprite / pattern

- 画像デコード: PNG(`png`)、JPEG(`zune-jpeg`)、WebP(`image-webp`)。いずれも純 Rust・wasm32 確認済み。テクスチャはアップロード時に丸め付きでプリマルチプライ、raster タイルは box フィルタのミップマップ付き(`LINEAR_MIPMAP_NEAREST` 相当の λ 選択)、image ソースはミップマップなし。
- raster シェーダ移植(hue-rotate / saturation / contrast / brightness / opacity / resampling)、ピクセル整列射影(`_alignedProjMatrix`)、image ソースの射影ワープ(`calculateImageWarp`、必要時 16×16 分割メッシュ)。
- 欠落タイルの扱いを上流どおりに: vector の 404 は空タイル、raster の 404 は祖先タイル(`maxUnderzooming` = 10 段まで)で代替、raster の空レスポンス(204)は透明タイル。重なったタイルは高ズーム優先でマスク。
- sprite: `@2x`(pixelRatio > 1)、配列形式(`id:name`)、パターンは 1px ラップ付きパディング(ImageAtlas と同じ)。background / fill / line pattern、SDF パターン(`fwidth` は三角形ごとの varying 勾配から再現)、パターン付き fill outline。
- 三角形ラスタライズの共有辺を厳密化(辺関数を正規化した端点から評価し、隣接三角形で完全に符号反転させる)。
- WASM: 1.6 MB(未最適化、画像デコーダ 3 種込み)。

### フェーズ6: symbol(`crates/core/src/symbol/`)

- `glyphs.rs`: PBF グリフのパースと fontstack×256 コードポイント単位の範囲ストア。`needs()` はデコード済みタイルの text を評価してから範囲 URL を返す(style → タイル → グリフの段階的確定)。縦書きで置換されうる句読点の範囲も上流どおり要求する。
- `shaping.rs`: `shapeText`/`TaggedString` の移植(badness 最小の改行、justify、anchor 揃え、formatted のセクション・scale・vertical-align・画像、`shapeIcon`/`fitIconToText`/`applyTextFit`)。縦書き(`isLineVertical`、line ラベルの `determineLineVerticals`、句読点の縦書き形 `verticalizePunctuation`)。
- `layout.rs`: `SymbolBucket.populate` + `performSymbolLayout`(トークン解決、`text-transform`、point / line / line-center / polygon(pole of inaccessibility)のアンカー、`mergeLines`、`anchorIsTooClose`、text-size/icon-size の SizeData(constant/source/camera/composite、上流と同じ 128 倍パック)、quad(縦グリフの -90° 回転、icon-text-fit の nine-patch stretch)、Int16 に落とす衝突ボックス、variable anchor のオフセット)。
- `placement.rs`: `GridIndex`/`CollisionIndex`/`Placement` の移植(viewport padding 100、overlap never/always/cooperative、ignore-placement、optional、variable anchor の 2 パス、writing-mode 順の横/縦配置、line ラベルの collision circle、sort-key のタイル横断ソート、viewport-y、`crossSourceCollisions`)。fadeDuration 0 の定常状態 = 「配置されたものだけ表示」。
- `projection.rs`: `placeGlyphsAlongLine` / `placeGlyphAlongLine`(line-offset、keep-upright の反転、急勾配で縦書きへ切替える `useVertical`)。pitch 0 前提でラベル平面は画面(CSS px)。
- `draw.rs`: `symbol_sdf`/`symbol_icon`/`symbol_text_and_icon` シェーダの再現(SDF のしきい値・gamma・halo、halo と本体の 1 パス/2 パス切替 `isGlyphOverlap`、LINEAR/NEAREST の選択、`a_offset` の 1/32 量子化、`pixelOffset`/`minFontScale` の Int16)。タイルとシンボルの描画順(地図回転込み)、sort-key の区間ソート。
- 上流の癖で再現しているもの: layout が同一のレイヤは 1 つのバケットを共有し配置は先頭レイヤ分のみ(同じラベルが 2 回描かれる)、`text-size`(camera)のサイズはタイルズーム+1 の値で頭打ち、衝突ボックスは Int16 に切り捨て、描画時の layout 値は地図ズームで評価(バケットはタイルズーム)。
- API 追加: `Renderer::set_cross_source_collisions(bool)`(MapLibre の Map オプション。render テストの `crossSourceCollisions`)。
- 実スタイル確認: demotiles(国名ラベル)と OpenFreeMap liberty(東京、CJK・アイコン・シールド・line ラベル)を WASM 経由で描画できることを確認。WASM 1.86 MB(未最適化)。

## 未対応・既知の問題

### symbol の残り失敗 20 件

| 件数 | テスト | 原因 |
|---|---|---|
| 9 | `text-arabic/*`, `text-field/formatted-arabic`, `text-writing-mode/point_label/cjk-arabic-vertical-mode` | 双方向テキスト(bidi)とアラビア文字の字形整形が未実装(論理順のまま並べる)。 |
| 5 | `is-supported-script/*`, `text-local-glyphs/complex-script`, `regressions/mapbox-gl-native#11729`, `geometry-type/all-geometries` | MapLibre 6 は複合文字スクリプト(デーヴァナーガリー、クメール等)や取得できなかったグリフ範囲をブラウザのフォントで描く(TinySDF)。フォントを持たないため再現不可(グリフは欠落扱い)。 |
| 1 | `text-variable-anchor/rotated-offset` | 上流はタイルが届くたびに再配置し、前回のアンカーを優先して試す(`prevAnchor`)。1 回の配置ではこの履歴依存を再現できない。 |
| 5 | `visibility/symbol/visible`(0.0027), `symbol-placement/line-overlap`(0.0041), `text-field/formatted-images`(0.00043), `symbol-placement/point-polygon-high-zoom`(0.00026), `combinations/symbol-translucent--fill-translucent`(0.00098) | 小差分。visible は期待画像で一部アイコンの上下 1px が欠ける(原因未特定、NEAREST の texel 境界を疑ったが丸めでは変わらず)。line-overlap は z22 の line ラベルが約 0.5px ずれる(未特定)。translucent は fill のアウトライン右端の AA。 |

### その他

1. composite 式(zoom と feature の両方に依存)は表示ズームで直接評価している。MapLibre はタイルズームの前後で評価してシェーダで補間するため、指数補間などでわずかに差が出うる(symbol のサイズは上流どおりパックして補間)。
2. タイル欠落時の親/子タイルでの穴埋め(MapLibre の retained tiles)未対応。symbol の CrossTileSymbolIndex(ズーム間の重複除去)も未実装(同一ズームのタイル間では不要)。
3. feature-state は常に空(静的レンダリングのため仕様上も対象外)。
4. 照合はルート照合のみ。`number-format` は en-US の書式のみ(通貨・単位は主要なもの)。
5. `is-supported-script` は常に true。
6. symbol: グラフェムクラスタは 1 コードポイントずつ扱う(MapLibre もグリフファイルに無いクラスタはそうする)。単語区切りの無いスクリプト(タイ語等)の改行位置は未対応。`font-faces` と縦書き用グリフ variant は対象外。pitch 前提のコード(遠近補正、pitched label plane)は pitch 0 に簡約。
7. Unicode 文字種判定(縦書きの upright/neutral、句読点・記号、Nd/Lu)は範囲表と std の近似。

## 次フェーズの前提

- フェーズ5(sans-IO API の確定 + WASM + JS ホスト)の人間レビューが未実施。`needs()` の段階は style → (TileJSON / GeoJSON / sprite json+png / image) → タイル → (欠落 raster の祖先 / グリフ範囲)。グリフ範囲はデコード済みタイルの text 評価で確定するため、`needs()` の度に symbol レイヤのテキストを評価する(`provide()` は直前の `needs()` が返したグリフ URL を引くだけ。したがってグリフ範囲は `needs()` が返した URL でのみ受け付ける)。
- 現 API: `Renderer::new(style, View)` / `set_max_zoom` / `set_cross_source_collisions` / `needs()` / `provide(url, Option<bytes>)` / `render()`。`provide(None)` の意味は上流の 404 に合わせている(vector は空、raster は祖先、グリフ範囲は欠落)。
- WASM は専用 `wasm` プロファイルと simd128 でビルド（上記）。spec.json の縮小や画像デコーダの feature 化は将来のサイズ削減候補。
- CLI ランナーはハーネス依存の挙動(maxCanvasSize による DPR 縮小、`readPixels` の左下切り出し、`maxZoom`、`crossSourceCollisions`、`sparse204` の 204 応答)を再現済み。
