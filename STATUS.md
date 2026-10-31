# STATUS

最終更新: 2026-10-31(フェーズ2・3・4 完了)

## スコープ決定(2026-10-31、人間判断)

- geojson / image ソースは対象。
- 実行時のスタイル・カメラ変更は対象外。`metadata.test.operations` に wait/idle/sleep/redraw 以外を含むテストは skip。
- API の最小形は「style.json + XYZ → タイル画像」(`View::tile`)。任意カメラは `View` で指定。
- 投影は mercator のみ。

## 通過率

Expression: **581 / 583(99.7%)**

Render: **pass 480 / fail 432 / skip 823**(in scope 912 中 52.6%)。pass のうち 435 件は差分 0(ピクセル完全一致)。

| layer type | pass | fail | skip | 通過率 |
|---|---|---|---|---|
| background | 191 | 168 | 411 | 53.2% |
| circle | 106 | 47 | 132 | 69.3% |
| fill | 112 | 11 | 100 | 91.1% |
| line | 180 | 24 | 84 | 88.2% |
| raster | 82 | 1 | 81 | 98.8% |
| symbol | 9 | 432 | 245 | 2.0% |

(1テストは使用する全レイヤ種別に計上)

**fail 432 はすべて symbol レイヤを含むテスト。symbol を含まないテストは全件通過。**

## 実装済み

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

## 未対応・既知の問題

1. **symbol**(フェーズ6)。
2. composite 式(zoom と feature の両方に依存)は表示ズームで直接評価している。MapLibre はタイルズームの前後で評価してシェーダで補間するため、指数補間などでわずかに差が出うる(現テストでは顕在化していない)。
3. GeoJSON の `cluster` 未対応(supercluster 未移植)。
4. タイル欠落時の親/子タイルでの穴埋め(MapLibre の retained tiles)未対応。
5. feature-state は常に空(静的レンダリングのため仕様上も対象外)。
6. 照合はルート照合のみ(上記)。`number-format` は en-US の書式のみ(通貨・単位は主要なもの)。
7. `is-supported-script` は常に true。

## 次フェーズ(5: sans-IO API の確定 + WASM + JS ホスト)の前提

- 現 API: `Renderer::new(style, View)` / `set_max_zoom` / `needs()` / `provide(url, Option<bytes>)` / `render()`。`provide(None)` の意味(vector は空、raster は祖先で代替)は上流の 404 に合わせている。404 以外の失敗を区別したい場合は API 拡張が必要。
- `needs()` の段階: style → (TileJSON / GeoJSON / sprite json+png / image) → タイル → (欠落 raster の祖先)。フェーズ6でグリフ範囲が加わる。
- `wasm/` は素の C-ABI。`examples/browser` がホスト実装例(自動再描画・状態表示付き)。
- WASM サイズ 1.6 MB: `opt-level="z"`、`wasm-opt`、LTO、spec.json の縮小、画像デコーダの feature 化などで削減余地。
- CLI ランナーはハーネス依存の挙動(maxCanvasSize による DPR 縮小、`readPixels` の左下切り出し、`maxZoom`、`sparse204` の 204 応答)を再現済み。
