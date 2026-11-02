import crypto from 'node:crypto';

export function createOperatorAccess({username,password}){
  if(!username||!password)throw new Error('Configure local operator credentials');
  const expected=crypto.createHash('sha256').update(username+':'+password).digest();
  return (req,res,next)=>{
    const operatorPath=req.path==='/operador.html'||
      (req.path.startsWith('/api/')&&(req.method!=='POST'||!['/api/reservations','/api/guarantors','/api/documents','/api/ocr/dni'].includes(req.path)));
    if(!operatorPath)return next();
    let valid=false;
    try{
      const h=req.headers.authorization||'';
      if(h.startsWith('Basic ')){
        const actual=crypto.createHash('sha256').update(Buffer.from(h.slice(6),'base64')).digest();
        valid=crypto.timingSafeEqual(actual,expected);
      }
    }catch{}
    if(valid)return next();
    res.setHeader('WWW-Authenticate','Basic realm="Portfolio Operator"');
    return res.status(401).json({error:'operator_auth_required'});
  };
}
