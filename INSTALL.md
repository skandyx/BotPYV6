# BOTPY Deployment Guide

This guide provides step-by-step instructions to deploy the BOTPY trading bot application on a Linux VPS (Virtual Private Server), such as one at `botpy.alex-com.tn`.

This setup uses **Nginx** as a reverse proxy to serve the frontend and route API calls, and **PM2** to keep the backend trading bot running 24/7.

---

## 1. Prerequisites

Before you begin, you need:
- A Linux VPS (Ubuntu 22.04 LTS is recommended).
- A domain name (e.g., `botpy.alex-com.tn`) pointed to your VPS's IP address.
- SSH access to your VPS.
- Basic knowledge of the Linux command line.

---

## 2. Server Setup

Connect to your VPS via SSH and perform the following steps.

### 2.1. Install Node.js

The bot's backend runs on Node.js. We'll use `nvm` (Node Version Manager) to install it, which is the recommended way.

```bash
# Update package lists
sudo apt update

# Install curl to download nvm
sudo apt install curl -y

# Download and run the nvm installation script
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash

# Load nvm into your current shell session
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
[ -s "$NVM_DIR/bash_completion" ] && \. "$NVM_DIR/bash_completion"

# Verify nvm is loaded (optional)
command -v nvm

# Install a recent LTS (Long Term Support) version of Node.js
nvm install --lts

# Verify Node.js and npm are installed
node -v
npm -v
```

### 2.2. Install PM2

PM2 is a process manager for Node.js applications. It will automatically restart the bot if it crashes and keep it running in the background.

```bash
npm install pm2 -g
```

### 2.3. Install Nginx

Nginx is a high-performance web server. We will use it to serve our React dashboard and to act as a reverse proxy for our backend API.

```bash
sudo apt install nginx -y

# Enable Nginx to start on server boot
sudo systemctl enable nginx

# Start Nginx
sudo systemctl start nginx
```

---

## 3. Application Deployment

### 3.1. Get the Code

Clone your application code onto the server from your Git repository.

```bash
# Replace with your repository URL
git clone <your-git-repository-url> botpy
cd botpy
```

### 3.2. Install Dependencies

Install the dependencies for both the frontend and the backend.

```bash
# From the root directory of your project
npm run install:all
```
*(This command is configured in the new `package.json` to install for both `backend` and the root `frontend`)*.

### 3.3. Configure the Backend

The backend is configured using an environment file.

```bash
# Go to the backend directory
cd backend

# Create a .env file from the example template
cp envexemple.txt .env
```

Now, edit the `.env` file with your specific configuration using a text editor like `nano`:

```bash
nano .env
```

You **must** set the following variables:
- `NODE_ENV`: Set to `production` for deployment. This enables secure cookies and other optimizations.
- `PORT`: The port the backend will run on (e.g., `8080`).
- `APP_PASSWORD`: A strong, secret password to access the dashboard.
- `BINANCE_API_KEY`: Your Binance API key.
- `BINANCE_SECRET_KEY`: Your Binance secret key.

You can also adjust any of the default trading parameters here. Save the file and exit (`CTRL+X`, then `Y`, then `Enter`).

### 3.4. Build the Frontend

From the project's **root** directory, build the static files for the React dashboard.

```bash
# Make sure you are in the root directory
cd .. 

npm run build
```
This will create an optimized version of your dashboard in a `dist/` directory.

---

## 4. Running the Bot with PM2

Now we will start the backend server using PM2.

```bash
# Go to the backend directory
cd backend

# Start the server with PM2
# It will automatically pick up the .env file from the current directory
pm2 start server.js --name botpy-backend

# To ensure the bot restarts automatically after a server reboot:
pm2 startup
pm2 save
```

You can check the status and logs of your bot with:
```bash
pm2 status
pm2 logs botpy-backend
```

---

## 5. Configuring Nginx as a Reverse Proxy

The final step is to tell Nginx how to serve your application.

### 5.1. Create an Nginx Configuration File

```bash
sudo nano /etc/nginx/sites-available/botpy
```

Paste the following configuration into the file. **Remember to replace `botpy.alex-com.tn` with your actual domain name and `8080` with the `PORT` you set in your `.env` file.**

```nginx
server {
    listen 80;
    server_name botpy.alex-com.tn;

    # Root directory for the built frontend files
    root /path/to/your/botpy/dist; 
    index index.html;

    location / {
        try_files $uri /index.html;
    }

    # Reverse proxy for API calls
    location /api/ {
        proxy_pass http://localhost:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # Reverse proxy for WebSocket connections
    # This block is crucial for real-time communication
    location /ws {
        proxy_pass http://localhost:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "Upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 86400; # Keep connection open
    }
}
```
**Important:** Replace `/path/to/your/botpy/dist` with the actual absolute path to your project's `dist` folder (e.g., `/home/your_user/botpy/dist`).

### 5.2. Enable the Configuration

```bash
# Create a symbolic link to enable the site
sudo ln -s /etc/nginx/sites-available/botpy /etc/nginx/sites-enabled/

# Remove the default Nginx config if it exists
sudo rm /etc/nginx/sites-enabled/default

# Test your Nginx configuration for errors
sudo nginx -t

# If the test is successful, restart Nginx to apply the changes
sudo systemctl restart nginx
```

---

## ✅ Installation Complete!

Your bot is now running 24/7. You can access your dashboard by visiting `http://botpy.alex-com.tn` in your web browser.

**Recommendation:** For a production deployment, it is highly recommended to secure your site with an SSL certificate (HTTPS). You can get a free certificate from Let's Encrypt using the `certbot` tool.
```bash
sudo apt install certbot python3-certbot-nginx -y
sudo certbot --nginx -d botpy.alex-com.tn
```
Certbot will automatically update your Nginx configuration for you.