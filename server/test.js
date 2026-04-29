const h=require('http')
h.get('http://localhost:3002/api/users',r=>{
  let d=''
  r.on('data',c=>d+=c)
  r.on('end',()=>console.log(d))
}).on('error',e=>console.error(e.message))
