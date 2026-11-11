# MapLibre style 2D タイルレンダラ (TypeScript)

## 目的

MapLibre style (style-spec JSON) を**タイルベースの2D表現に限って**仕様準拠でレンダリングする最小のレンダラ。純 TypeScript(WASM なし)で、ブラウザ / Node / Deno / Cloudflare Workers で動く。GPU・ネイティブバイナリ・WASM なしで静止画(RGBA)を返せることが価値。

「完璧」の定義: **対象レイヤについて maplibre-gl-js の render-tests が許容差内で通ること**。ピクセル完全一致は目指さない(GPU とソフトウェアラスタライズの差)。

前提を忘れないこと: 正確さだけが目的なら MapLibre Native(ヘッドレス可)を使うほうが安い。本プロジェクトの価値は「GPU不要・軽量・純 JS・サーバレス」。

## 経緯

当初は Rust(WASM)で実装し、TypeScript に移植した(Rust 版と render テスト全件の判定が一致することを確認して置き換え)。移植元の Rust 実装は git 履歴にある。上流が npm で出している実装(`@maplibre/maplibre-gl-style-spec`, `@maplibre/geojson-vt`, `earcut`, `pixelmatch`)は移植せずそのまま使う(上流と一致させるのが目的なので、上流そのものが最も正確)。純 JS がなく Workers にネイティブ API もない WebP だけ `image-webp` 0.2.4 から自前で移植した。

## スコープ

対象:
- style-spec のパースと式(expression)評価(`@maplibre/maplibre-gl-style-spec` をそのまま使う)
- ソース: vector(MVT), raster, raster-dem, geojson, image
- 投影: 描画は Web Mercator。カメラは center / zoom / bearing(2D 回転)。投影座標系への再投影(`setProjectedView`: PROJJSON + bbox。PROJ 文字列は受け付けない(CRS の表現は PROJJSON に一本化)。経緯度 / 横メルカトル / メルカトル・Pseudo Mercator / ランベルト正角円錐 / 極ステレオ / laea / Equal Earth / geos、楕円体対応・測地系変換なし、座標は常に東・北の順)は、ベクタ(fill / line / circle / heatmap / symbol / background)は頂点を投影して出力側に直接描く(タイル空間で線分・三角形を細分化、線幅などのピクセル長は投影の局所回転で画面空間に押し出し、タイルのクリップは出力画素ごとの Mercator 位置から決める、投影の反子午線をまたぐタイルは世界コピーで描き分ける。`*-pattern` は投影後の画面ピクセル上に、CRS 座標に固定した原点から整数ズームの Mercator と同じ縮尺(パターン 1px = 1 CSS px、タイルごとのズームに依らない)で一様に敷く。破線と line-pattern は線に沿った投影後の距離で敷き、位相はタイル境界との交点で揃えて交点間を整数周期に伸縮する(タイルごとに切られた線の始点から数えると境界で途切れるため))。raster / DEM だけ Mercator で描いた「絵」をメッシュで warp する
- レイヤ: background / fill / line / circle / raster / symbol / hillshade / color-relief / heatmap
- sprite(fill-pattern, line-pattern, icon)、glyph(SDF PBF)

非対象(手を出さない): fill-extrusion / 3D / pitch / terrain / globe・GPU 的な非mercator投影(maplibre の globe 等) / sky / light、実行時のスタイル・カメラ変更(setPaintProperty / setStyle / setFeatureState 等。render テストの `operations` は wait 系以外を含めば skip)、ネットワーク取得・キャッシュ・PMTiles 読み出し(ホストの責務)。

## 設計制約(厳守)

- **純 TypeScript のみ。WASM・ネイティブアドオン禁止。** `src/core` は `node:*` や DOM API に依存しない(ブラウザ / Node / Deno / Workers 共通)。依存の npm パッケージは純 JS に限り、採用前に Workers でも動くこと(同期 API・`node:*` 非依存)を確認する。TypeScript は erasable syntax のみ(Node の型ストリップでそのまま動く。`enum` / `namespace` / パラメータプロパティ禁止)、相対 import は `.ts` 拡張子付き。
- **API の最小形は「style.json + XYZ → タイル画像」**: `new Renderer(style, View.tile(z, x, y, tileSize))`。`View`(center/zoom/bearing/サイズ/pixel_ratio)は任意カメラ用の一般形で、render テストはこちらを使う。スタイルは生成時に固定(変更 API は作らない)。`setView` でカメラだけ切り替えると、取得済みリソースとタイル単位のバケット(線のテッセレーション・塗りの earcut)を再利用する(ソースごとに LRU で `MAX_CACHED_TILES` まで)。再利用しないホストは `keepBuckets = false` にする(公開 API では `ttlMs: 0`)と、線・塗り・円・ヒートマップのバケットを最後に使うレイヤを描いた時点で捨てる(Workers の 128MB に収めるため)。ジオメトリは点ごとの配列やオブジェクトにせず、レイヤやバケット単位の型付き配列に詰める(密なタイルは数百万点)。1つのレンダラで描画を重ねて走らせるホストは、描画ごとに増加するチケットを `setTicket` で渡し、`renderRetaining(進行中で最古のチケット)` で描く(他の描画がまだ描いていないタイルを追い出さない。公開 API は描画の連番を使う)。
- **Sans-IO**: `core` は fetch / ファイル / async / スレッド / 時計に依存しない。`Renderer` が:
  - `needs(): Resource[]`: 現時点で必要な未取得リソース(tile / glyph range / sprite json / sprite png / TileJSON など)
  - `provide(url, bytes | undefined)`: 取得済みバイト列を渡す(`undefined` = 取得失敗/404)
  - `render(): {width, height, data}`(RGBA): `needs()` が空のときのみ呼べる
- 必要リソースは**段階的に確定する**(タイル取得 → MVTデコードと式評価でテキスト確定 → glyph range 確定)。ホストは `needs()` が空になるまで取得と `provide()` を繰り返す。1往復で済む前提の設計にしない。
- `needs()` の段階: style → (TileJSON / GeoJSON / sprite json+png / image) → タイル → (欠落 raster の祖先 / グリフ範囲)。`provide` は現在のビューではなく `needs()` が返した URL の記録と照合する(`needs` と `provide` の間に `setView` されても取りこぼさない)。`provide(undefined)` は上流の 404 と同じ意味(vector は空タイル、raster は祖先で代替、グリフ範囲は欠落)。
- 取得済みバイト列のキャッシュはホストの責務(公開 API は同一 URL の同時取得をまとめるだけ)。
- 単一スレッド。並列化しない。
- 採用済み依存(すべて純 JS): `@maplibre/maplibre-gl-style-spec`(式・関数・フィルタ・Color 等の値)、`@maplibre/geojson-vt`(GeoJSON タイル化とクラスタ)、`earcut`、`fflate`(gzip / zlib)、`fast-png`、`jpeg-js`、`pbf`(グリフ)。テスト用に `pixelmatch`。描画は自前のソフトウェア GL(Canvas 等は使わない: GL の AA・合成規則と一致させるため)。
- 数値は JS の倍精度でよい(f32 の丸めは再現しない)。結果を変える整数の意味(切り捨て・飽和・Int16/Int8 の桁あふれ・半分を 0 から遠ざける丸め)は `src/core/util.ts` の補助関数で明示的に再現する。
- テキストは SDF グリフを自前でしきい値処理して合成(halo / text-opacity もこの層)。MapLibre は HarfBuzz を使わず PBF グリフのメトリクスで自前レイアウトしているので、`shaping` / `placement` のアルゴリズムを再現する。RTL 等は後回し。

## 構成

- `packages/ml2drender/src/core/` — 純粋ロジック(sans-IO、同期)。
  - `renderer.ts`(`Renderer` / `View` / `Resource`、ソース管理・needs/provide・描画の順序)、`style.ts`(レイヤ・プロパティ・フィルタを style-spec でコンパイルする薄い層。`PropValue` が定数・式・legacy function を同じ形で評価する。評価失敗は style-spec と同じく既定値に落とすが警告は出さない)、`util.ts`(整数・丸めの意味)。
  - `mvt.ts`(MVT デコード、overzoom 分割)、`geojson.ts`(`@maplibre/geojson-vt` によるタイル化・クラスタ、source の `filter`)、`tile.ts`(Transform・タイル被覆・URL)、`projection.ts`(投影式と PROJJSON の解釈。内部では PROJJSON を PROJ 文字列相当のパラメータに落として読む)、`reproject.ts`(raster / DEM の warp。頂点から描くレイヤは `Transform.reprojected` 経由で出力座標へ)、`image.ts`(画像デコード・GL 風テクスチャ)、`webp.ts` + `webp/`(image-webp 0.2.4 の移植: デコーダと可逆エンコーダ。Rust と出力のバイト一致を確認済み)、`encode.ts`(PNG / WebP エンコード)、`sprite.ts`(sprite 読み込み)。
  - `render/` — `raster.ts` がソフトウェア GL(三角形・GL ライン・合成・マスク)、`mod.ts` / `line.ts` / `raster_layer.ts` / `pattern.ts` / `dem.ts` / `heatmap.ts` が各レイヤのバケット生成とシェーダ再現。
  - `symbol/` — `glyphs.ts`(PBF グリフ)、`shaping.ts`、`layout.ts`(バケット・quad・衝突ボックス)、`placement.ts`(衝突判定)、`projection.ts`(line ラベル)、`draw.ts`(SDF/アイコンのシェーダ)。
  - 方針: MapLibre の **バケット生成とシェーダの計算を移植**し(ジオメトリ・式・量子化)、GL と同じ規則でラスタライズする。GPU パイプラインの構造は真似せず、出力が変わらない範囲で独自に組み替えてよい(深度バッファの代わりに画素ごとの最上位不透明レイヤを記録、varying の平面補間、バケットの描画間再利用など)。pitch 依存の計算は pitch 0 に簡約する。上流の量子化・桁あふれ等の癖も再現する(例: extrude の Int8 桁あふれ、GL の top-left 規則を y-down バッファでは「左辺+下辺」に読み替え、`linesofar` の量子化、overzoom 分割 `zoomLevelsToOverscale`=4 と vt-pbf 再エンコードの切り捨て、衝突ボックスの Int16 切り捨て、layout 同一レイヤのバケット共有)。
- `packages/ml2drender/src/index.ts` — 公開 API。リソース取得(同一 URL の同時取得をまとめる)とレンダラの再利用(`cache.ttlMs`)を隠す。描画は Mercator 前提の `renderView`(center / zoom / bearing)・`renderZxy`(XYZ タイル)・`renderLngLat`(経緯度 bbox と長辺の画素数。縦横比とズームは bbox から決める)と、`renderProjected`(PROJJSON + bbox)に分け、どれも RGBA の `RenderedImage` を返し、`image.toPng()` / `toWebp()` でエンコードする(形式が増えても `toXxx()` を足すだけ)。`loadProjection(crs)` は描画と同じ投影式(forward / inverse)を返す(タイル範囲の計算や GL JS の `addProjection` 用)。
- `packages/ml2drender/tests/` — `render-tests.ts`(上流 render テストのランナー)、`exclusions.json`(対象外 render テストの除外ルール(理由付き)。pitch/roll/非mercator/operations はランナー内にハードコード)、`expression-tests.ts`、`single-flight.ts`(取得の重複排除)、`api-types.ts`(型テスト)。
- `examples/browser/` — pnpm パッケージ `demo-browser`(Vite + TypeScript、maplibre-gl は npm 依存)。ml2drender の出力だけを GL JS のラスタタイルとして表示する(GL JS 自身のベクタ描画は使わない)。左の Style JSON・PROJJSON・GeoJSON の入力が正(UI は英語)。各欄は見出しで開閉し、閉じているときはプルダウン(`src/styles.ts`、`src/projjson-presets.json`、GeoJSON は `main.ts` 内)だけ、開くと直接編集できる。入力は 500ms のデバウンスで自動反映し、Style / PROJJSON が変わったときだけタイルを描き直す(反映は直列化)。PROJJSON が空なら Web Mercator を再投影なしで描く。PROJJSON は `loadProjection` の投影式と、bbox(適用範囲)を投影した正方形のタイル格子で GL JS の `addProjection` に登録し(`src/projections.ts`)、各タイルを `renderProjected`(空なら `renderZxy`)で描く。投影の整合確認に GeoJSON 欄(既定は Natural Earth の都市)だけは GL JS 自身が描く(点は円、線・面も描く。ホバーで属性表示。変更は `setData` のみ)。GL JS は GeoJSON を Worker でタイル化するため、`src/gl-projection-handler.ts` を `importScriptInWorkers` で読み込み、`setProjectionHandler` に `loadProjectionFactory` の同期版を渡す(URL 末尾の `#.mjs` は GL JS にモジュールとして直接 import させるため、`vite.config.ts` の `worker.format: 'es'` は top-level await のため)。位置は URL ハッシュに残る。`needs`→fetch→`provide` ループのホスト実装例を兼ねる。JS API は `ml2drender` を `workspace:*` で参照。社内標準のフロントエンド既定は SvelteKit だが、1画面の検証用ツールなので素の Vite にしている。
- `fixtures/` — 上流テスト(gitignore)。`scripts/fetch-fixtures.sh` が固定コミットから取得し LICENSE を同梱する。

## コマンド

全体を pnpm で管理する。Node は `.node-version`(26, Active LTS)、pnpm は `packageManager` で固定。`pnpm-workspace.yaml` で `minimumReleaseAge: 10080`(公開7日未満の版は入れない)。JS は TypeScript のみ(`.js` を新規に作らない)。

```sh
pnpm install
pnpm fixtures                      # 初回のみ(~144MB)
pnpm test                          # パッケージのテスト(single-flight)
pnpm test:render [filter]          # → target/test-report/render/{summary.md,results.json,<id>/diff.png}
pnpm test:expression [filter]      # → target/test-report/expression/{summary.md,failures.json}
pnpm bench base=<checkout> head=. # 性能比較(fixture 使用、各 checkout で pnpm install 済み。TS 移植前の checkout は WASM で描く)。PR では .github/workflows/bench.yml が base と比較しコメント
pnpm demo                          # Vite dev server(examples/browser)
pnpm typecheck                     # tsc --noEmit(全パッケージ)
```

比較は maplibre-gl-js と同じ: pixelmatch 8.0.0、`threshold` 既定 0.1285、`allowed`(不一致画素率)既定 0.00025、テストごとの `metadata.test` 指定があればそれに従う。`expected*.png` が複数あれば最小差分を採用。expression は上流と同じく数値を有効数字6桁で比較。

## ルール

- **テスト特化のハードコード、特定ケースへの分岐は禁止。** 仕様に基づく実装のみ。通らないケースは通らないまま残す。
- 差が大きい失敗(アンチエイリアスやジョイン形状以外)は個別に原因を調査する。アンチエイリアスやジョイン形状は MapLibre(GPU)と差が出るので許容差で吸収する。
- **高速化・省メモリ化は render テストの判定を変えない。** `pnpm test:render` の全件の判定が変更前と一致することを確認する(`results.json` の `hash` は比較した RGBA の SHA-256 なので、変更前の結果と突き合わせれば出力のビット一致も確かめられる)。出力が変わる近似は、差が 8bit の量子化程度に収まるものに限り、差分率の変化と `pnpm bench` の出力差を PR に書く。ただし DEM(hillshade / color-relief)は画素単位の差も許容せず、RGBA をビット一致させる(`Math.*` を近似に置き換えない)。計測は `pnpm bench`(中央値)で前後を比較し、効果が誤差の範囲の試作は採用しない。
- **メルカトル固有の仮定を増やさない。** 将来は他の投影も対応する予定なので、最適化の適用可否は地理座標・緯度・bearing 0 ではなく投影後の画面形状から判断する。
- タイル単位のキャッシュは、中身が依存するものをすべてキーに含める(例: symbol バケットは layout グループ・wrap・ピクセル比、線/塗りは overscaled zoom)。`setView` で使い回したレンダラと新しいレンダラの出力が一致することを確認する。

## 既知の非対応(仕様上・設計上の理由で通らないもの)

- 双方向テキスト(bidi)・アラビア文字の字形整形。
- 複合文字スクリプトや取得できなかったグリフ範囲のブラウザフォント描画(TinySDF)。フォントを持たないため再現不可。
- 配置の履歴依存(`prevAnchor`)、CrossTileSymbolIndex、retained tiles。単発の静止画描画では再現しない。
- ロケール別照合(照合はルート照合のみ)、`number-format` は en-US のみ、`is-supported-script` は常に true、feature-state は常に空。
- composite 式は表示ズームで直接評価(上流はタイルズーム前後の値をシェーダで補間。symbol のサイズのみ上流どおり)。
