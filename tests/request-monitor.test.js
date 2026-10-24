import { describe, expect, it } from 'vitest';
import { createRequestMonitor } from '../server/app/request-monitor.mjs';

describe('privileged request monitoring', () => {
  it('reports rolling request totals without exposing source addresses', () => {
    const monitor=createRequestMonitor({now:()=>0});
    monitor.record({method:'GET',url:'/api/timetable?secret=value',status:200,source:'192.168.1.55'},0);
    monitor.record({method:'GET',url:'/api/missing',status:404,source:'192.168.1.55'},1);
    const report=monitor.snapshot(2);
    expect(report.currentMinute).toMatchObject({requests:2,notFound:1});
    expect(report.currentMinute.topRoutes).toContainEqual({route:'GET /api/timetable',requests:1});
    expect(JSON.stringify(report)).not.toContain('192.168.1.55');
    expect(JSON.stringify(report)).not.toContain('secret=value');
  });

  it('flags repeated scanning and authorization failures but never declares identity', () => {
    const monitor=createRequestMonitor({now:()=>0});
    for(let index=0;index<20;index+=1) monitor.record({url:`/missing/${index}`,status:404,source:'scanner'},index);
    for(let index=0;index<10;index+=1) monitor.record({url:'/api/auth/me',status:401,source:'scanner'},index);
    const [flagged]=monitor.snapshot(10).suspiciousSources;
    expect(flagged.indicators).toEqual(expect.arrayContaining(['route-scanning','authorization-failures']));
    expect(flagged.source).toMatch(/^[a-f0-9]{12}$/);
  });

  it('drops request data outside its retention window', () => {
    const monitor=createRequestMonitor({retentionMinutes:2,now:()=>0});
    monitor.record({url:'/',status:200,source:'one'},0);
    expect(monitor.snapshot(120_000).last60Minutes.requests).toBe(0);
  });
});
