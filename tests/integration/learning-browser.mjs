import assert from 'node:assert/strict';
import { chromium,expect } from '@playwright/test';
import { PNG } from 'pngjs';
import jsQR from 'jsqr';

export async function testLearningBrowser({base,service,activities,classroom,teacher=3}) {
  const browser=await chromium.launch({channel:'msedge',headless:true});
  const contexts=[];
  const pageFor=async(id,path='/classroom/',mobile=false)=>{
    const context=await browser.newContext({viewport:mobile?{width:390,height:844}:{width:1280,height:900}});contexts.push(context);
    const page=await context.newPage();page.setDefaultTimeout(15000);await page.goto(base+path);
    await page.locator('#login-form input[name=username]').fill(`fixture-${id}`);
    await page.locator('#login-form input[name=password]').fill('fixture-password-only-2026');
    await page.locator('#login-form button[type=submit]').click();
    await page.locator('.learning-module').waitFor();return page;
  };
  try{
    const creator=await pageFor(1);creator.on('dialog',(dialog)=>dialog.accept());
    await creator.getByLabel('工作空間名稱',{exact:true}).fill('UI建立者工作空間');await creator.getByRole('button',{name:'建立工作空間',exact:true}).click();
    await expect(creator.getByRole('button',{name:'建立工作空間',exact:true})).toBeEnabled();
    const [newWorkspace]=await service.transaction((tx)=>tx.execute("SELECT id FROM learning_workspaces WHERE name='UI建立者工作空間' ORDER BY id DESC LIMIT 1"));
    await creator.locator(`[data-learning="workspace:${newWorkspace.id}"]`).click();await creator.getByLabel('搜尋帳號或確切 ID').fill('fixture-2');await creator.getByRole('button',{name:'搜尋',exact:true}).click();
    await creator.locator('[data-learning="grant-manager:2"]').click();await expect(creator.locator('[data-learning="grant-manager:2"]')).toBeEnabled();
    const manager=await pageFor(2);
    await manager.getByRole('button',{name:'班級與人員授權',exact:true}).first().click();
    await manager.getByLabel('搜尋帳號或確切 ID').fill('fixture-50');await manager.getByRole('button',{name:'搜尋',exact:true}).click();
    await manager.getByRole('button',{name:'授予教師',exact:true}).waitFor();
    assert.equal(await manager.getByRole('button',{name:'授予管理員',exact:true}).count(),0);
    manager.on('dialog',(dialog)=>dialog.accept());
    await manager.getByLabel('新班級名稱',{exact:true}).fill('瀏覽器班級');await manager.getByRole('button',{name:'建立班級',exact:true}).click();
    await manager.getByRole('button',{name:'開啟班級',exact:true}).first().waitFor();
    const [browserClass]=await service.transaction((tx)=>tx.execute("SELECT id FROM learning_classrooms WHERE name='瀏覽器班級' ORDER BY id DESC LIMIT 1"));classroom=browserClass.id;
    await manager.locator(`[data-learning="class:${classroom}"]`).click();
    await manager.getByLabel('已授權教師的確切 ID',{exact:true}).fill(String(teacher));await manager.getByRole('button',{name:'確認班級教師指派',exact:true}).click();
    await manager.getByRole('button',{name:'建立七天學生加入政策',exact:true}).click();
    await expect(manager.getByRole('button',{name:'建立七天學生加入政策',exact:true})).toBeEnabled();
    const [policyRow]=await service.transaction((tx)=>tx.execute('SELECT id FROM learning_invite_policies WHERE classroom_id=? ORDER BY id DESC LIMIT 1',[classroom]));
    const invitation=await service.displayToken(teacher,classroom,policyRow.id);
    const student=await pageFor(50,`/join/#${invitation.token}`,true);
    await student.getByRole('button',{name:'確認加入',exact:true}).click();
    await student.getByText('已以學生身分加入 瀏覽器班級',{exact:true}).waitFor();
    const second=await pageFor(4,`/join/#${invitation.token}`,true);await second.getByRole('button',{name:'確認加入',exact:true}).click();await second.getByText('已以學生身分加入 瀏覽器班級',{exact:true}).waitFor();
    const teacherPage=await pageFor(teacher);
    const prompts=[];teacherPage.on('dialog',(dialog)=>dialog.accept(prompts.shift()??''));
    await teacherPage.locator(`[data-learning="class:${classroom}"]`).click();
    await teacherPage.getByRole('button',{name:'展示十五分鐘加入碼',exact:true}).last().click();
    const qr=teacherPage.locator('img[alt="班級或互評連結 QR"]');await qr.waitFor();
    const data=await qr.getAttribute('src');const png=PNG.sync.read(Buffer.from(data.split(',')[1],'base64'));
    const decoded=jsQR(new Uint8ClampedArray(png.data),png.width,png.height);assert.ok(decoded?.data.includes('/join/#'));
    assert.equal(new URL(decoded.data).origin,new URL(base).origin);
    await teacherPage.getByLabel('活動標題',{exact:true}).fill('瀏覽器驗收報告');
    await teacherPage.getByLabel('台北預定時間',{exact:true}).fill('2026-10-26T11:00');
    await teacherPage.getByRole('button',{name:'建立報告活動',exact:true}).click();
    await teacherPage.getByRole('heading',{name:'瀏覽器驗收報告',exact:true}).waitFor();
    const [record]=await service.transaction((tx)=>tx.execute("SELECT id FROM learning_activities WHERE title='瀏覽器驗收報告' ORDER BY id DESC LIMIT 1"));
    const activity=record.id;
    for(const name of ['甲組','乙組']){prompts.push(name);await teacherPage.getByRole('button',{name:'新增組別',exact:true}).click();await expect(teacherPage.getByRole('button',{name:'新增組別',exact:true})).toBeEnabled();}
    // Read IDs only; all grouping changes go through browser controls.
    await teacherPage.getByRole('button',{name:'新增組別',exact:true}).waitFor();
    let detail=await activities.detail(teacher,activity);
    for(const [index,userId]of [4,50].entries()){prompts.push(String(detail.groups[index].id));await teacherPage.locator(`[data-learning="move:${userId}"]`).click();}
    await teacherPage.locator(`[data-learning="down:${detail.groups[0].id}"]`).click();await teacherPage.locator(`[data-learning="up:${detail.groups[0].id}"]`).click();
    await teacherPage.getByRole('button',{name:'開始活動',exact:true}).click();
    await teacherPage.getByRole('button',{name:'開始下一組報告',exact:true}).click();
    await teacherPage.getByRole('button',{name:'開放互評並產生 QR',exact:true}).click();
    await teacherPage.locator('img[alt="班級或互評連結 QR"]').waitFor();
    const evaluationUrl=await teacherPage.getByRole('link',{name:'開啟連結',exact:true}).getAttribute('href');
    await second.goto(evaluationUrl);await second.getByText('不可自評',{exact:true}).waitFor();
    await student.goto(evaluationUrl);await student.locator('form[data-form="evaluate"]').waitFor();
    const selects=student.locator('form[data-form="evaluate"] select');await selects.nth(0).selectOption('5');await selects.nth(1).selectOption('4');await selects.nth(2).selectOption('3');
    await student.getByLabel('留言（選填，最多 500 字元）',{exact:true}).fill('<script>window.bad=true</script>');
    let loseResponse=true;await student.route('**/api/learning/rounds/*/submit',async(route)=>{const response=await route.fetch();assert.equal(response.status(),200,await response.text());if(loseResponse){loseResponse=false;await route.abort('failed');}else await route.fulfill({response});});
    student.on('dialog',(dialog)=>dialog.accept());await student.getByRole('button',{name:'確認並送出評分',exact:true}).click();
    await expect(student.getByRole('button',{name:'確認並送出評分',exact:true})).toBeEnabled();
    await expect(student.getByLabel('留言（選填，最多 500 字元）',{exact:true})).toHaveValue('<script>window.bad=true</script>');
    await teacherPage.getByRole('button',{name:'關閉互評',exact:true}).click();
    await student.getByRole('button',{name:'確認並送出評分',exact:true}).click();await student.getByText(/已提交，收據/).waitFor();
    await student.reload();await student.getByText(/已提交，收據/).waitFor();assert.equal(await student.evaluate(()=>window.bad),undefined);
    await teacherPage.getByRole('button',{name:'開始下一組報告',exact:true}).click();
    const secondOpen=teacherPage.waitForResponse((response)=>response.url().endsWith('/transition')&&response.request().postDataJSON()?.action==='open');
    await teacherPage.getByRole('button',{name:'開放互評並產生 QR',exact:true}).click();const opened=await (await secondOpen).json();
    await expect(teacherPage.getByRole('link',{name:'開啟連結',exact:true})).toHaveAttribute('href',opened.url);const secondUrl=opened.url;
    await second.goto(secondUrl);await second.locator('form[data-form="evaluate"]').waitFor();for(const select of await second.locator('form[data-form="evaluate"] select').all())await select.selectOption('4');
    second.on('dialog',(dialog)=>dialog.accept());await second.getByRole('button',{name:'確認並送出評分',exact:true}).click();await second.getByText(/已提交，收據/).waitFor();
    await teacherPage.getByRole('button',{name:'關閉互評',exact:true}).click();
    await teacherPage.getByRole('button',{name:'結束整場活動',exact:true}).click();await teacherPage.getByRole('button',{name:'發布彙總結果',exact:true}).click();
    await teacherPage.getByRole('button',{name:'查看結果與明細',exact:true}).click();await teacherPage.getByText(/甲組/).first().waitFor();
    // Each account retains its own browser cookie jar; server rejects student raw-result request.
    const cookies=await student.context().cookies();const cookie=cookies.map((c)=>`${c.name}=${c.value}`).join('; ');
    const response=await fetch(`${base}/api/learning/activities/${activity}/results?details=true`,{headers:{cookie}});const results=await response.json();assert.equal(response.status,200);assert.equal(results.evaluations,undefined);
    assert.equal(await student.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    return {browser:'Microsoft Edge headless',isolatedContexts:contexts.length,qrDecoded:true,physicalPhoneScan:false,flows:['creator workspace creation and manager grant','manager scoped account search, classroom creation and teacher assignment','mobile join and login return','teacher create, group, order and two presentations','self-evaluation rejected','lost response keeps input; same-key retry after close returns receipt','close/end/publish and student summary privacy']};
  }catch(error){
    for(const context of contexts)for(const page of context.pages())console.error('Fixture browser diagnostic:',new URL(page.url()).pathname,(await page.locator('body').innerText().catch(()=>'' )).slice(0,2500));
    throw error;
  }finally{for(const context of contexts)await context.close();await browser.close();}
}
