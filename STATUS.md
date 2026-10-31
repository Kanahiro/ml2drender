# STATUS

最終更新: 2026-10-31(フェーズ2・3・4・6 完了。フェーズ5の人間レビューを経ずに、指示によりフェーズ6(symbol)を先行実施)

## スコープ決定(2026-10-31、人間判断)

- geojson / image ソースは対象。
- 実行時のスタイル・カメラ変更は対象外。`metadata.test.operations` に wait/idle/sleep/redraw 以外を含むテストは skip。
- API の最小形は「style.json + XYZ → タイル画像」(`View::tile`)。任意カメラは `View` で指定。
- 投影は mercator のみ。

## 通過率

Expression: **581 / 583(99.7%)**

Render: **pass 889 / fail 23 / skip 823**(in scope 912 中 97.5%)。pass のうち 834 件は差分 0(ピクセル完全一致)。

| layer type | pass | fail | skip | 通過率 |
|---|---|---|---|---|
| background | 352 | 7 | 411 | 98.1% |
| circle | 149 | 4 | 132 | 97.4% |
| fill | 121 | 2 | 100 | 98.4% |
| line | 202 | 2 | 84 | 99.0% |
| raster | 83 | 0 | 81 | 100.0% |
| symbol | 418 | 23 | 245 | 94.8% |

(1テストは使用する全レイヤ種別に計上。fail 23 はすべて symbol レイヤを含むテスト。内訳は「未対応・既知の問題」)

## 実装済み

### 描画余白 (`margin`)

- `MapRenderer.render(view)` / Rust `View` に `margin` を追加（非負整数の CSS ピクセル、既定 0）。余白を含むタイル取得・symbol 配置・描画後に、元の出力サイズへ切り出す。WASM ABI の `renderer_new` にも引数を追加したため、ホストと WASM は一緒に更新する。
- 元のカメラ中心・ラスターのピクセル整列を保持。小数 DPR は余白をデバイスピクセルへ丸める。ブラウザデモは `margin: 128` を使用。
- 隣接タイルのアイコン、余白分のタイル取得、極域の中心維持、小数 DPR・回転時の射影とピクセル整列を単体テストで確認。margin はタイル間の独立した衝突判定による配置差を完全には解消しない。

### フェーズ2: 式評価(`core/src/expression/`)

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

### フェーズ6: symbol(`core/src/symbol/`)

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

### symbol の残り失敗 23 件

| 件数 | テスト | 原因 |
|---|---|---|
| 9 | `text-arabic/*`, `text-field/formatted-arabic`, `text-writing-mode/point_label/cjk-arabic-vertical-mode` | 双方向テキスト(bidi)とアラビア文字の字形整形が未実装(論理順のまま並べる)。 |
| 3 | `geojson/clustered*` | GeoJSON の `cluster`(supercluster)未移植。 |
| 5 | `is-supported-script/*`, `text-local-glyphs/complex-script`, `regressions/mapbox-gl-native#11729`, `geometry-type/all-geometries` | MapLibre 6 は複合文字スクリプト(デーヴァナーガリー、クメール等)や取得できなかったグリフ範囲をブラウザのフォントで描く(TinySDF)。フォントを持たないため再現不可(グリフは欠落扱い)。 |
| 1 | `text-variable-anchor/rotated-offset` | 上流はタイルが届くたびに再配置し、前回のアンカーを優先して試す(`prevAnchor`)。1 回の配置ではこの履歴依存を再現できない。 |
| 5 | `visibility/symbol/visible`(0.0027), `symbol-placement/line-overlap`(0.0041), `text-field/formatted-images`(0.00043), `symbol-placement/point-polygon-high-zoom`(0.00026), `combinations/symbol-translucent--fill-translucent`(0.00098) | 小差分。visible は期待画像で一部アイコンの上下 1px が欠ける(原因未特定、NEAREST の texel 境界を疑ったが丸めでは変わらず)。line-overlap は z22 の line ラベルが約 0.5px ずれる(未特定)。translucent は fill のアウトライン右端の AA。 |

### その他

1. composite 式(zoom と feature の両方に依存)は表示ズームで直接評価している。MapLibre はタイルズームの前後で評価してシェーダで補間するため、指数補間などでわずかに差が出うる(symbol のサイズは上流どおりパックして補間)。
2. GeoJSON の `cluster` 未対応(上記)。
3. タイル欠落時の親/子タイルでの穴埋め(MapLibre の retained tiles)未対応。symbol の CrossTileSymbolIndex(ズーム間の重複除去)も未実装(同一ズームのタイル間では不要)。
4. feature-state は常に空(静的レンダリングのため仕様上も対象外)。
5. 照合はルート照合のみ。`number-format` は en-US の書式のみ(通貨・単位は主要なもの)。
6. `is-supported-script` は常に true。
7. symbol: グラフェムクラスタは 1 コードポイントずつ扱う(MapLibre もグリフファイルに無いクラスタはそうする)。単語区切りの無いスクリプト(タイ語等)の改行位置は未対応。`font-faces` と縦書き用グリフ variant は対象外。pitch 前提のコード(遠近補正、pitched label plane)は pitch 0 に簡約。
8. Unicode 文字種判定(縦書きの upright/neutral、句読点・記号、Nd/Lu)は範囲表と std の近似。

## 次フェーズの前提

- フェーズ5(sans-IO API の確定 + WASM + JS ホスト)の人間レビューが未実施。`needs()` の段階は style → (TileJSON / GeoJSON / sprite json+png / image) → タイル → (欠落 raster の祖先 / グリフ範囲)。グリフ範囲はデコード済みタイルの text 評価で確定するため、`needs()` の度に symbol レイヤのテキストを評価する(`provide()` は直前の `needs()` が返したグリフ URL を引くだけ。したがってグリフ範囲は `needs()` が返した URL でのみ受け付ける)。
- 現 API: `Renderer::new(style, View)` / `set_max_zoom` / `set_cross_source_collisions` / `needs()` / `provide(url, Option<bytes>)` / `render()`。`provide(None)` の意味は上流の 404 に合わせている(vector は空、raster は祖先、グリフ範囲は欠落)。
- WASM 1.86 MB: `opt-level="z"`、`wasm-opt`、LTO、spec.json の縮小、画像デコーダの feature 化などで削減余地。
- CLI ランナーはハーネス依存の挙動(maxCanvasSize による DPR 縮小、`readPixels` の左下切り出し、`maxZoom`、`crossSourceCollisions`、`sparse204` の 204 応答)を再現済み。
