import './globals.css';

export const metadata = {
  title: 'NAEMU',
  description: 'Spin up agents and actions'
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-theme="dark" suppressHydrationWarning>
      <head>
        <link rel="icon" href="/naemufav.png" />
        <script dangerouslySetInnerHTML={{ __html: `
(function(){
  try {
    var saved = localStorage.getItem('theme');
    var want = saved || 'dark';
    document.documentElement.setAttribute('data-theme', want);
    if (saved !== want) localStorage.setItem('theme', want);
  } catch(e){}
})();
` }} />
        <style>{`html,body{background: var(--bg1);}`}</style>
      </head>
      <body>
        <header className="topbar">
          <a className="brand" href="/" style={{ gap: 6 }}>
            <img src="/naemu2.png" alt="" height={22} style={{ display: 'block' }} />
            <strong style={{ marginLeft: 6 }}>NAEMU</strong>
            <span className="beta" style={{ marginLeft: 6 }}>BETA</span>
          </a>
          <div className="top-actions" style={{ gap: 10 }}>
            <button id="themeToggle" className="icon-btn" title="Toggle theme" aria-label="Theme">
              <svg id="themeIcon" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M6.76 4.84l-1.8-1.79M12 3V1M17.24 4.84l1.8-1.79M21 12h2M19.04 19.04l1.41 1.41M12 23v-2M2.59 20.45l1.41-1.41M1 12h2" stroke="currentColor" strokeWidth="1.5"/>
                <circle cx="12" cy="12" r="5" stroke="currentColor" strokeWidth="1.5"/>
              </svg>
            </button>
            <a href="https://www.asterdex.com/en/referral/AC792c" target="_blank" rel="noopener noreferrer" className="icon-btn" title="Aster" aria-label="Aster">
              <img id="asterIcon" src="/asterwhite.svg" alt="Aster" style={{ width: 20, height: 20 }} />
            </a>
            <a href="/docs.html" target="_blank" rel="noopener noreferrer" className="icon-btn" title="Docs" aria-label="Docs">
              <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M7 3h7l5 5v13a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" stroke="currentColor" strokeWidth="1.5"/><path d="M14 3v5h5" stroke="currentColor" strokeWidth="1.5"/></svg>
            </a>
            <a href="https://x.com/naemudesk" target="_blank" rel="noopener noreferrer" className="icon-btn" title="X" aria-label="X">
              <svg viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>
            </a>
            <a href="https://github.com/naemu" target="_blank" rel="noopener noreferrer" className="icon-btn" title="GitHub" aria-label="GitHub">
              <svg viewBox="0 0 16 16" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>
            </a>
          </div>
        </header>
        <script dangerouslySetInnerHTML={{ __html: `
(function(){
  function sun(){return '<path d="M6.76 4.84l-1.8-1.79M12 3V1M17.24 4.84l1.8-1.79M21 12h2M19.04 19.04l1.41 1.41M12 23v-2M2.59 20.45l1.41-1.41M1 12h2" stroke="currentColor" stroke-width="1.5"/><circle cx="12" cy="12" r="5" stroke="currentColor" stroke-width="1.5"/>';}
  function moon(){return '<path d="M12 3a9 9 0 1 0 9 9c0-.34-.02-.68-.06-1.01A7 7 0 0 1 12 3z" stroke="currentColor" stroke-width="1.5"/>';}
  function setIcon(){
    var isDark = document.documentElement.getAttribute('data-theme')==='dark';
    var ico=document.getElementById('themeIcon'); if(ico) ico.innerHTML = isDark ? sun() : moon();
    var aster=document.getElementById('asterIcon'); if(aster) aster.setAttribute('src', isDark ? '/asterwhite.svg' : '/asterblack.svg');
  }
  function init(){
    setIcon();
    var btn=document.getElementById('themeToggle'); if(!btn) return;
    btn.addEventListener('click', function(){
      var el=document.documentElement; var isDark=el.getAttribute('data-theme')==='dark';
      var next=isDark?'light':'dark'; el.setAttribute('data-theme', next); try{localStorage.setItem('theme', next);}catch(e){}
      setIcon();
    });
  }
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
` }} />
        {children}
      </body>
    </html>
  );
}
