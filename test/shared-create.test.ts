import { describe, expect, test } from 'bun:test';
import { SharedSessionCreator, buildSharedCreateCard } from '../src/core/shared-create.js';

function fixture() {
  const profiles = [{id:'wb-one',revision:1,label:'模型一'}, {id:'wb-off',revision:1,label:'不可用'}, {id:'cc',revision:1,label:'CC'}];
  const boot = {csrfToken:'test-token',modelRouteProfiles:profiles,modelRouteCompatibility:[
    {harnessId:'workbuddy',available:true,profileRef:{id:'wb-one',revision:1}},
    {harnessId:'workbuddy',available:false,profileRef:{id:'wb-off',revision:1}},
    {harnessId:'claude-code',available:true,profileRef:{id:'cc',revision:1}},
  ]};
  const detail = {case:{id:'case-1',workspacePath:'/tmp/native-new',runtimes:{workbuddy:{paneId:'w1:p1',terminalId:'terminal-1',sessionId:'session-1',herdrSession:'default'}}}};
  const posts: any[] = [];
  const request = (async (url: string, init: RequestInit) => {
    if (url.endsWith('/api/bootstrap')) return Response.json(boot);
    if (init.method === 'POST') {
      expect((init.headers as Record<string,string>)['x-allinone-token']).toBe('test-token');
      expect(init.redirect).toBe('error');
      posts.push(JSON.parse(init.body as string));
      return Response.json(detail,{status:201});
    }
    return Response.json(detail);
  }) as typeof fetch;
  return {client:new SharedSessionCreator('http://127.0.0.1:4318',request),boot,detail,posts};
}

describe('Lark creates native sessions through AllInOne', () => {
  test('only offers available exact profile revisions for the current Agent', async () => {
    const f=fixture();
    expect((await f.client.list('codebuddy')).map(p=>p.id)).toEqual(['wb-one']);
    expect((await f.client.list('claude-code')).map(p=>p.id)).toEqual(['cc']);
    f.boot.modelRouteCompatibility[0]!.profileRef.revision=2;
    expect(await f.client.list('codebuddy')).toEqual([]);
  });
  test('rejects unavailable or cross-Agent profile before creating anything', async () => {
    const f=fixture();
    await expect(f.client.create('codebuddy','wb-off','app','root')).rejects.toThrow('不可用');
    await expect(f.client.create('codebuddy','cc','app','root')).rejects.toThrow('不可用');
    expect(f.posts).toHaveLength(0);
  });
  test('repeated clicks use the same durable topic mutation key; other topics differ', async () => {
    const f=fixture();
    expect((await f.client.create('codebuddy','wb-one','app','root')).runtimes?.workbuddy?.terminalId).toBe('terminal-1');
    await f.client.create('codebuddy','wb-one','app','root');
    await f.client.create('codebuddy','wb-one','app','other');
    expect(f.posts[0]).toEqual(f.posts[1]);
    expect(f.posts[0].mutationKey).not.toEqual(f.posts[2].mutationKey);
    expect(f.posts[0]).toMatchObject({adapterId:'workbuddy',profileRef:{id:'wb-one',revision:1}});
    expect(f.posts[0]).not.toHaveProperty('workspacePath');
  });
  test('failed native startup retains case identity and never issues a recovery or replacement', async () => {
    const f=fixture();
    (f.detail.case as any).nativeStartError='需要登录';
    await expect(f.client.create('codebuddy','wb-one','app','root')).rejects.toThrow('case-1');
    await expect(f.client.create('codebuddy','wb-one','app','root')).rejects.toThrow('不会重复创建');
    expect(f.posts[0]).toEqual(f.posts[1]);
  });
  test('HTTP failure is reported instead of claiming creation succeeded', async () => {
    const client = new SharedSessionCreator('http://127.0.0.1:4318', (async()=>Response.json({error:{message:'服务未就绪'}},{status:503})) as typeof fetch);
    await expect(client.list('codebuddy')).rejects.toThrow('服务未就绪');
  });
  test('rejects nonlocal endpoints and credentials', () => {
    for (const base of ['https://example.com','http://127.0.0.1.example.com','http://u:p@localhost:4318']) {
      expect(()=>new SharedSessionCreator(base)).toThrow('本机');
    }
  });
  test('new-session card pins each choice to the topic and its invoker', async () => {
    const f=fixture(), card=JSON.parse(buildSharedCreateCard(await f.client.list('codebuddy'),'root','user'));
    expect(card.body.elements[1].behaviors[0].value).toEqual({action:'shared_create',root_id:'root',invoker_open_id:'user',profile_id:'wb-one'});
  });
});
