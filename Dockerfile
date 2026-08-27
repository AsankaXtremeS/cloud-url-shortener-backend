FROM node:22-alpine

# Install OpenSSL and compatibility libraries for Prisma on Alpine (musl)
RUN apk add --no-cache openssl libc6-compat

WORKDIR /app

COPY package*.json ./

RUN npm ci --omit=dev

COPY prisma ./prisma

RUN npx prisma generate

COPY . .

EXPOSE 5000

CMD ["npm", "start"]