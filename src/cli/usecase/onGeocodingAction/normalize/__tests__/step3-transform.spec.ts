import { describe, expect, it, jest } from '@jest/globals';
import Stream from "node:stream";
import { pipeline } from 'node:stream/promises';
import { Query } from "../../query.class";
import { FromStep3Type, PrefectureName } from "../../types";
import { NormalizeStep3 } from '../step3-transform';
import { WritableStreamToArray } from './stream-to-array';

describe('step3transform', () => {
  
  it('都道府県名が判別出来ていない場合は、step3aに続くstreamを呼び出す', async () => {

    const dummyData = Query.create(`千葉市どこか`);
    const dummyStream = new Stream.Readable({
      objectMode: true,
    });
    const pushMethod = jest.spyOn(dummyStream, 'push');
    pushMethod.mockImplementation((chunk: FromStep3Type | null) => {
      // streamを進める必要があるので、callbackは実行しておく
      chunk?.callback();
      return true;
    });
    const target = new NormalizeStep3(dummyStream);
    const outputWrite = new WritableStreamToArray<Query>();

    await pipeline(
      Stream.Readable.from([
        dummyData,
      ], {
        objectMode: true,
      }),
      target,
      outputWrite
    );
    
    // 都道府県名が判別出来ているので、step3a に続く
    // stream のpushが「呼び出されている」ことを確認 
    //
    // streamの最後を示すnullだけは呼び出されるので、
    // 2回呼び出されることを確認すれば良い
    expect(pushMethod).toHaveBeenCalledTimes(2); 

  });

  it('都道府県名が判別出来ている場合はスキップする', async () => {
    const dummyData = Query.create(`千葉市どこか`).copy({
      prefectureName: PrefectureName.CHIBA,
    });

    const dummyStream = new Stream.Readable({
      objectMode: true,
    });
    const pushMethod = jest.spyOn(dummyStream, 'push');

    const target = new NormalizeStep3(dummyStream);
    const outputWrite = new WritableStreamToArray<Query>();

    await pipeline(
      Stream.Readable.from([
        dummyData,
      ], {
        objectMode: true,
      }),
      target,
      outputWrite
    );
    
    // 都道府県名が判別出来ているので、step3a に続く
    // stream のpushが「呼び出されていない」ことを確認 
    // (streamの最後を示すnullだけは呼び出される)
    expect(pushMethod).toHaveBeenCalledTimes(1); 
    expect(pushMethod).toHaveBeenLastCalledWith(null);

    // step3の結果として、入力値と同じものが返ってくることを確認
    const actualValues = outputWrite.toArray();
    expect(actualValues.length).toBe(1);
    expect(actualValues[0]).toEqual(dummyData);

  });
});
