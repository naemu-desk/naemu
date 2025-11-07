"use client";

import { useEffect, useState } from 'react';

export default function ThemeToggle() {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    
    function sun() {
      return '<path d="M6.76 4.84l-1.8-1.79M12 3V1M17.24 4.84l1.8-1.79M21 12h2M19.04 19.04l1.41 1.41M12 23v-2M2.59 20.45l1.41-1.41M1 12h2" stroke="currentColor" stroke-width="1.5"/><circle cx="12" cy="12" r="5" stroke="currentColor" stroke-width="1.5"/>';
    }
    
    function moon() {
      return '<path d="M12 3a9 9 0 1 0 9 9c0-.34-.02-.68-.06-1.01A7 7 0 0 1 12 3z" stroke="currentColor" stroke-width="1.5"/>';
    }
    
    function setIcon() {
      const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
      const ico = document.getElementById('themeIcon');
      if (ico) ico.innerHTML = isDark ? sun() : moon();
      const aster = document.getElementById('asterIcon');
      if (aster) aster.setAttribute('src', isDark ? '/asterwhite.svg' : '/asterblack.svg');
    }
    
    function handleClick() {
      const el = document.documentElement;
      const isDark = el.getAttribute('data-theme') === 'dark';
      const next = isDark ? 'light' : 'dark';
      el.setAttribute('data-theme', next);
      try {
        localStorage.setItem('theme', next);
      } catch (e) {}
      setIcon();
    }
    
    setIcon();
    const btn = document.getElementById('themeToggle');
    if (btn) {
      btn.addEventListener('click', handleClick);
      return () => {
        btn.removeEventListener('click', handleClick);
      };
    }
  }, []);

  return null;
}

