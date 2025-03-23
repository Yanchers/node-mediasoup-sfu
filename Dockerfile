FROM node:20-bullseye
RUN apt-get -y update
RUN apt-get -y install build-essential python3 python3-pip valgrind
COPY ./package.json .
RUN --mount=type=cache,target=/node_modules npm install mediasoup@3
RUN --mount=type=cache,target=/node_modules npm install 
COPY ./index.ts .
RUN npm run build
CMD [ "node", "index.js" ]  

# FROM node:20
# WORKDIR /app
# RUN apt -y update
# RUN apt -y install python3-pip
# COPY ./package.json .
# RUN npm i