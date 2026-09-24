# mLabsFlow Uploader

Servidor pequeno que existe só para receber vídeos grandes (acima de ~90MB)
para o mLabs Flow, contornando o limite de 100MB de requisição do plano
gratuito do Cloudflare Workers.

O banco de dados (D1) e o armazenamento de mídia (R2) continuam sendo os
mesmos usados pelo Worker `mlabsflow-youtube` — este serviço só fala com
eles por fora (D1 via API HTTP, R2 via API compatível com S3), sem
duplicar nada.

## Rotas

- `POST /api/instagram/upload-media` — mesmo contrato do Worker: recebe o
  campo `media` e retorna `{ ok, key, url }`.
- `POST /api/youtube/upload` — mesmo contrato do Worker: recebe
  `userId, title, description, privacyStatus, publishAt, video` e retorna
  `{ ok, videoId, url }`.

## Por que HTTP/2

O Cloud Run tem um limite de 32MB por requisição **só para HTTP/1**. Para
aceitar vídeos maiores, o servidor precisa falar HTTP/2 "cleartext" (h2c)
e o serviço no Cloud Run precisa estar configurado com **"Use HTTP/2
end-to-end"** ativado (isso é uma opção nas configurações do serviço, não
precisa mudar nada no código).

## Deploy no Cloud Run

1. Crie um novo serviço no Cloud Run, apontando para este repositório
   (Cloud Run consegue buildar direto de um Dockerfile).
2. Nas configurações do serviço:
   - **Use HTTP/2 end-to-end**: ativado (essencial — sem isso, volta o
     limite de 32MB).
   - **Memória**: pelo menos 1 GiB (o upload do YouTube monta o vídeo
     inteiro em memória antes de mandar pro Google, igual o Worker já
     fazia).
   - **Concorrência**: 1 requisição por instância (evita duas pessoas
     competindo pela mesma memória ao mandar vídeo grande ao mesmo tempo).
3. Configure as variáveis de ambiente / secrets listadas em
   `.env.example`.
4. Depois do deploy, anote a URL do serviço (algo como
   `https://mlabsflow-uploader-xxxxx.a.run.app`) — ela entra no
   `index.html` como a URL pra onde os uploads grandes são mandados.

## Rodando localmente (só para testar)

```
cp .env.example .env
# preencha o .env com valores reais
npm install
npm start
```
