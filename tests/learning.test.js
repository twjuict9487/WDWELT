import { describe,it,expect } from 'vitest';
import { validateEvaluation,summarizeEvaluations,learningTime } from '../server/app/learning-activities.mjs';
import { createLearningApi } from '../server/app/learning-api.mjs';

const criteria=[{id:1,name:'內容'},{id:2,name:'表達'},{id:3,name:'合作'}];
const payload=(scores)=>({requestKey:'abcdefghijklmnop',scores:scores.map((score,index)=>({criterionId:index+1,score})),comment:' <script>alert(1)</script> '});
describe('classroom evaluation rules',()=>{
  it('accepts explicit Taipei times and rejects invalid calendar dates or an implicit timezone',()=>{
    expect(learningTime('2026-10-26T09:00+08:00')).toBe('2026-10-26 09:00:00');
    for(const value of ['2026-02-30T09:00+08:00','2026-10-26T09:00','2026-10-26T09:00Z'])expect(()=>learningTime(value)).toThrow();
  });
  it('checks exact integer rubric, unique IDs, unknown fields and comment length',()=>{
    for(const scores of [[0,4,3],[6,4,3],[1.2,4,3],['5',4,3],[5,4]])expect(()=>validateEvaluation(payload(scores),criteria)).toThrow();
    expect(()=>validateEvaluation({...payload([5,4,3]),reviewerId:7},criteria)).toThrow();
    expect(()=>validateEvaluation({...payload([5,4,3]),comment:'x'.repeat(501)},criteria)).toThrow();
    const duplicate=payload([5,4,3]);duplicate.scores[1].criterionId=1;
    expect(()=>validateEvaluation(duplicate,criteria)).toThrow();
    const valid=validateEvaluation(payload([5,4,3]),criteria);
    expect(valid.comment).toBe('<script>alert(1)</script>');
    expect(valid.hash.equals(validateEvaluation({...payload([5,4,3]),scores:payload([5,4,3]).scores.reverse()},criteria).hash)).toBe(true);
  });
  it('computes the requested three-group fixture without treating missing submissions as zero',()=>{
    const rows=[[5,4,3],[4,4,4],[3,3,3],[5,5,5]].map((values)=>({voided:false,scores:values.map((score,index)=>({criterionId:index+1,score}))}));
    let summary=summarizeEvaluations(criteria,rows);
    expect(summary.average).toBe(4);expect(summary.criteria.map((c)=>c.average)).toEqual([4.25,4,3.75]);
    rows[3].voided=true;summary=summarizeEvaluations(criteria,rows);
    expect(summary.valid).toBe(3);expect(summary.average).toBeCloseTo(3.6666666667);
    expect(summary.criteria.map((c)=>Number(c.average.toFixed(2)))).toEqual([4,3.67,3.33]);
    expect(summarizeEvaluations(criteria,[]).average).toBe(null);
  });
  it('fails closed while disabled and reports unavailable schema independently',async()=>{
    const input={request:{method:'GET'},url:new URL('http://localhost/api/learning/status'),sendJson:()=>{throw Error('unexpected');}};
    await expect(createLearningApi({database:{}})(input)).rejects.toMatchObject({status:404});
    const values=[];await createLearningApi({enabled:true,database:{hasMigration:async()=>false}})({...input,sendJson:(_r,status,body)=>values.push({status,body})});
    expect(values).toEqual([{status:200,body:{enabled:true,ready:false}}]);
  });
});
