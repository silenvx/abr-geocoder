import { Database, Statement } from "better-sqlite3";
import { DASH_SYMBOLS, KANJI_1to10_SYMBOLS } from "../../domain/constantValues";
import { DataField } from "../../domain/dataset/";
import { RegExpEx } from "../../domain/RegExpEx";
import { isKanjiNumberFollewedByCho } from './isKanjiNumberFollewedByCho';
import { kan2num } from './kan2num';
import { toRegexPattern } from "./toRegexPattern";
import { ITown, PrefectureName } from "./types";

export type TownRow = {
  lg_code: string;
  town_id: string;
  name: string;
  koaza: string;
  lat: number;
  lon: number
};

export type TownPattern = {
  town: ITown;
  pattern: string;
}

export type FindParameters = {
  address: string,
  prefecture: PrefectureName,
  cityName: string;
};

/**
 * 与えられた情報をもとに、Databaseを探索して可能性のある結果を返す
 * オリジナルコードの getNormalizedCity() 関連を１つにまとめたクラス。
 * 実質的にジオコーディングしている部分
 */
export class AddressFinder {

  private readonly getTownStatement: Statement;
  private readonly wildcardHelper: (address: string) => string;
  constructor({
    db,
    wildcardHelper,
  }: {
    db: Database;
    wildcardHelper: (address: string) => string;
  }) {
    this.wildcardHelper = wildcardHelper;

    // getTownList() で使用するSQLをstatementにしておく
    this.getTownStatement = db.prepare(`
      select
        "town".${DataField.LG_CODE},
        "town"."${DataField.TOWN_ID}",
        "${DataField.OAZA_TOWN_NAME}" || "${DataField.CHOME_NAME}" as "name",
        "${DataField.KOAZA_NAME}" as "koaza",
        "${DataField.REP_PNT_LAT}" as "lat",
        "${DataField.REP_PNT_LON}" as "lon"
      from
        "city"
        left join "town" on town.${DataField.LG_CODE} = city.${DataField.LG_CODE}
      where
        "city"."${DataField.PREF_NAME}" = @prefecture AND
        (
          "city"."${DataField.COUNTY_NAME}" ||
          "city"."${DataField.CITY_NAME}" ||
          "city"."${DataField.OD_CITY_NAME}"
        ) = @cityName AND
        "${DataField.TOWN_CODE}" <> 3;
    `);

  }

  async find({
    address,
    prefecture,
    cityName,
  }: FindParameters): Promise<ITown | null> {
    /*
     * オリジナルコード
     * https://github.com/digital-go-jp/abr-geocoder/blob/a42a079c2e2b9535e5cdd30d009454cddbbca90c/src/engine/normalize.ts#L133-L164
     */
    address = address.trim().replace(
      RegExpEx.create('^大字'),
      '',
    );
    const isKyotoCity = cityName.startsWith('京都市');

    // 都道府県名と市町村名から、その地域に所属する町（小区分）のリストをDatabaseから取得する
    const towns = await this.getTownList({
      prefecture,
      cityName,
    });

    // データベースから取得したリストから、マッチしそうな正規表現パターンを作成する
    const searchPatterns = this.createSearchPatterns({
      towns,
      isKyotoCity,
    }) 
    const townPatterns = this.toTownPatterns(searchPatterns);

    const regexPrefixes = ['^']
    if (isKyotoCity) {
      // 京都は通り名削除のために後方一致を使う
      regexPrefixes.push('.*')
    }

    // 作成した正規表現パターンに基づき、マッチするか全部試す
    for (const regexPrefix of regexPrefixes) {
      for (const {town, pattern} of townPatterns) {
        const modifiedPattern = this.wildcardHelper(pattern);
        const regex = RegExpEx.create(`${regexPrefix}${modifiedPattern}`);
        const match = address.match(regex);
        if (!match) {
          continue;
        }

        // 条件に一致するtownが見つかったケース
        return {
          lg_code: town.lg_code,
          lat: town.lat,
          lon: town.lon,
          originalName: town.originalName,
          town_id: town.town_id,
          koaza: town.koaza,
          name: address.substring(match[0].length),
        }
      }
    }

    // 条件に一致するtownが見つからない場合、nullを返す
    return null;
  }

  /**
   * オリジナルコード
   * https://github.com/digital-go-jp/abr-geocoder/blob/a42a079c2e2b9535e5cdd30d009454cddbbca90c/src/engine/lib/cacheRegexes.ts#L206-L318
   */
  private createSearchPatterns({
    towns,
    isKyotoCity,
  }: {
    towns: TownRow[];
    isKyotoCity: boolean;
  }): ITown[] {
    const townSet = new Set(towns.map((town) => town.name));
    

    // 町丁目に「○○町」が含まれるケースへの対応
    // 通常は「○○町」のうち「町」の省略を許容し同義語として扱うが、まれに自治体内に「○○町」と「○○」が共存しているケースがある。
    // この場合は町の省略は許容せず、入力された住所は書き分けられているものとして正規化を行う。
    // 更に、「愛知県名古屋市瑞穂区十六町1丁目」漢数字を含むケースだと丁目や番地・号の正規化が不可能になる。このようなケースも除外。
    const results: ITown[] = [];

    // 京都は通り名削除の処理があるため、意図しないマッチになるケースがある。これを除く
    if (isKyotoCity) {
      towns.forEach(town => {
        results.push({
          ...town,
          originalName: '',
        });
      });

      return results;
    }

    towns.forEach(town => {
      results.push({
        ...town,
        originalName: '',
      });

      if (!town.name.includes('町')) {
        return;
      }

      // 冒頭の「町」が付く地名（町田市など）は明らかに省略するべきないので、除外
      //
      // NOTE: "abbr" は何の略だろう...?
      const townAbbr = town.name.replace(
        RegExpEx.create('(?!^町)町', 'g'),
        '',
      );

      if (townSet.has(townAbbr)) {
        return;
      }

      // 大字は省略されるため、大字〇〇と〇〇町がコンフリクトする。このケースを除外
      if (townSet.has(`大字${townAbbr}`)) {
        return;
      }

      if (isKanjiNumberFollewedByCho(town.name)) {
        return;
      }

      // エイリアスとして「〇〇町」の"町"なしパターンを登録
      results.push({
        name: townAbbr,
        originalName: town.name,
        lg_code: town.lg_code,
        town_id: town.town_id,
        koaza: town.koaza,
        lat: town.lat,
        lon: town.lon,
      });
    });

    return results;
  }

  private toTownPatterns(searchPatterns: ITown[]): TownPattern[] {
    // 少ない文字数の地名に対してミスマッチしないように文字の長さ順にソート
    searchPatterns.sort((townA: ITown, townB: ITown) => {
      let aLen = townA.name.length
      let bLen = townB.name.length

      // 大字で始まる場合、優先度を低く設定する。
      // 大字XX と XXYY が存在するケースもあるので、 XXYY を先にマッチしたい
      if (townA.name.startsWith('大字')) aLen -= 2
      if (townB.name.startsWith('大字')) bLen -= 2

      return bLen - aLen
    });

    const patterns = searchPatterns.map(town => {

      const pattern = toRegexPattern(
        town.name
          // 横棒を含む場合（流通センター、など）に対応
          .replace(
            RegExpEx.create(`/[${DASH_SYMBOLS}]`, 'g'),
            `[${DASH_SYMBOLS}]`,
          )
          .replace(
            RegExpEx.create('大?字', 'g'),
            '(大?字)?',
          )
          // 以下住所マスターの町丁目に含まれる数字を正規表現に変換する
          .replace(
            RegExpEx.create(
              `([壱${KANJI_1to10_SYMBOLS}]+)(丁目?|番(町|丁)|条|軒|線|(の|ノ)町|地割|号)`,
              'g',
            ),
            (match: string) => {
              const patterns: string[] = []

              patterns.push(
                match.toString().replace(
                  RegExpEx.create('(丁目?|番(町|丁)|条|軒|線|(の|ノ)町|地割|号)'),
                  '',
                ),
              )
              
              // 漢数字
              if (match.match(RegExpEx.create('^壱'))) {
                patterns.push('一')
                patterns.push('1')
                patterns.push('１')
              } else {
                const num = match
                  .replace(
                    RegExpEx.create(`([${KANJI_1to10_SYMBOLS}]+)`, 'g'),
                    (match) => {
                      return kan2num(match)
                    },
                  )
                  .replace(
                    RegExpEx.create('(丁目?|番(町|丁)|条|軒|線|(の|ノ)町|地割|号)'),
                    '',
                  );

                patterns.push(num.toString()) // 半角アラビア数字
              }

              // 以下の正規表現は、上のよく似た正規表現とは違うことに注意！
              const prefixMatchers = patterns.join('|');
              return [
                `(${prefixMatchers})`,
                `((丁|町)目?|番(町|丁)|条|軒|線|の町?|地割|号|[${DASH_SYMBOLS}])`
              ].join('');
            },
          ),
      );

      return {
        town,
        pattern,
      };
    });

    // X丁目の丁目なしの数字だけ許容するため、最後に数字だけ追加していく
    for (const town of searchPatterns) {
      const chomeMatch = town.name.match(
        RegExpEx.create(`([^${KANJI_1to10_SYMBOLS}]+)([${KANJI_1to10_SYMBOLS}]+)(丁目?)`),
      );

      if (!chomeMatch) {
        continue
      }

      const chomeNamePart = chomeMatch[1]
      const chomeNum = chomeMatch[2]
      const pattern = toRegexPattern(
        `^${chomeNamePart}(${chomeNum}|${kan2num(chomeNum)})`,
      )
      patterns.push({
        town,
        pattern,
      });
    }

    return patterns;
  }

  /**
   * SQLを実行する
   * 
   * better-sqlite3自体はasyncではないが、将来的にTypeORMに変更したいので
   * asyncで関数を作っておく
   */
  private async getTownList({
    prefecture,
    cityName,
  }: {
    prefecture: PrefectureName;
    cityName: string
  }): Promise<TownRow[]> {
    const results = this.getTownStatement.all({
      prefecture,
      cityName,
    }) as TownRow[];

    return Promise.resolve(results);
  }
}