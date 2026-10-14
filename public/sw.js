self.addEventListener('push', (event) => {
  let data = { title: 'WDWELT', body: '你有新的課表提醒。', url: '/', tag: 'wdwelt' };
  try { data = { ...data, ...event.data.json() }; } catch { /* safe fallback */ }
  event.waitUntil(self.registration.showNotification(data.title, { body:data.body, tag:data.tag, icon:'/icon.svg', badge:'/icon.svg', data:{url:data.url} }));
});
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(clients.matchAll({type:'window',includeUncontrolled:true}).then((windows) => {
    const target=new URL(event.notification.data?.url || '/', self.location.origin).href;
    for (const window of windows) if ('focus' in window) { window.navigate(target); return window.focus(); }
    return clients.openWindow(target);
  }));
});
