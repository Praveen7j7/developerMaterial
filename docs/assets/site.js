
// theme toggle (default is the cream light theme; remember choice)
(function(){
  try{var t=localStorage.getItem('bh-theme'); if(t) document.documentElement.setAttribute('data-theme',t);}catch(e){}
  function flip(){var cur=document.documentElement.getAttribute('data-theme')==='dark'?'light':'dark';
    document.documentElement.setAttribute('data-theme',cur); try{localStorage.setItem('bh-theme',cur);}catch(e){}}
  document.addEventListener('click',function(e){var id=e.target&&e.target.id;
    if(id==='theme'||id==='theme-m')flip();
    if(id==='menu')document.getElementById('sidebar').classList.toggle('open');
    if(id==='to-top')window.scrollTo({top:0,behavior:'smooth'});});
  // show the back-to-top button once the reader is a screen down
  var top=document.getElementById('to-top');
  if(top){var onScroll=function(){top.classList.toggle('show',window.scrollY>600);};
    window.addEventListener('scroll',onScroll,{passive:true});onScroll();}
})();
// mermaid, theme-aware
(function(){ if(!window.mermaid) return;
  var dark=document.documentElement.getAttribute('data-theme')==='dark';
  mermaid.initialize({startOnLoad:true, theme: dark?'dark':'neutral', securityLevel:'loose'});
})();
// search across all parts and headings
(function(){
  var q=document.getElementById('q'), box=document.getElementById('results'), nav=document.getElementById('nav');
  if(!q) return; var idx=null;
  document.addEventListener('keydown',function(e){if(e.key==='/'&&document.activeElement!==q){e.preventDefault();q.focus();}});
  function load(cb){ if(idx){cb();return;} fetch('search-index.json').then(function(r){return r.json();}).then(function(d){idx=d;cb();}).catch(function(){idx=[];cb();}); }
  function run(){
    var term=q.value.trim().toLowerCase();
    if(!term){box.innerHTML='';nav.style.display='';return;}
    load(function(){
      nav.style.display='none';
      var hits=[]; for(var i=0;i<idx.length&&hits.length<40;i++){ if(idx[i].t.toLowerCase().indexOf(term)>=0) hits.push(idx[i]); }
      if(!hits.length){box.innerHTML='<div class="rk" style="padding:.4rem .5rem">No matches</div>';return;}
      box.innerHTML=hits.map(function(h){return '<a href="vol-'+h.v+'-'+h.s+'.html#'+h.a+'"><span class="rk">Part '+h.p+(h.k==='part'?' · part':' · section')+'</span><br>'+h.t.replace(/</g,'&lt;')+'</a>';}).join('');
    });
  }
  q.addEventListener('input',run);
})();
