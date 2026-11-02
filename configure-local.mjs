import {randomBytes} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
const secret=()=>randomBytes(24).toString('base64url');
const config=[
 'DB_NAME=portfolio_contracts',
 'DB_USER=portfolio_local',
 `DB_PASSWORD=${secret()}`,
 `MYSQL_ROOT_PASSWORD=${secret()}`,
 'OPERATOR_USER=local_operator',
 `OPERATOR_PASSWORD=${secret()}`,
].join('\n')+'\n';
await writeFile(fileURLToPath(new URL('.env',import.meta.url)),config,{flag:'wx',mode:0o600});
console.log('Configuracion local creada en .env. No compartir ni subir ese archivo.');
