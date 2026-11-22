import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';

const apiPort=process.env.API_PORT||3001;

export default defineConfig({
  plugins:[react()],
  server:{proxy:{'/api':{
    target:`http://127.0.0.1:${apiPort}`,
    configure(proxy){
      proxy.on('proxyReq',(proxyReq,req)=>{
        if(req.socket.remoteAddress)proxyReq.setHeader('x-forwarded-for',req.socket.remoteAddress);
      });
    }
  }}}
});
