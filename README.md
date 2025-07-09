# Intercom Inbox App

This is a sample Intercom Inbox app built with React, TypeScript, and Express. It demonstrates how to create an interactive app that can be embedded in the Intercom Inbox using Canvas Kit.

## Features

- Interactive form with checkboxes and buttons
- Simulated server endpoints for initializing and submitting forms
- Responsive design that works in the Intercom Inbox
- TypeScript for type safety

## Prerequisites

- Node.js (v14 or later)
- npm (v6 or later)
- An Intercom account with developer access

## Getting Started

1. **Clone the repository**
   ```bash
   git clone <repository-url>
   cd intercom-inbox-app
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Start the development server**
   ```bash
   npm run dev
   ```
   This will start both the React app (on port 3000) and the Express server (on port 3001).

## Project Structure

- `/src` - Contains the React application code
- `/server` - Contains the Express server code
- `/public` - Static files served by the React app

## Available Scripts

- `npm start` - Start the React app in development mode
- `npm run server` - Start the Express server
- `npm run dev` - Start both the React app and Express server concurrently
- `npm run build` - Build the React app for production
- `npm test` - Run tests

## Setting Up in Intercom

1. Build the app for production:
   ```bash
   npm run build
   ```

2. Deploy the `build` folder to a hosting service (e.g., Vercel, Netlify, or Firebase Hosting)

3. In your Intercom Developer settings:
   - Go to "Apps" and click "Create New"
   - Select "Canvas Kit"
   - Enter your app's URL (where you deployed the build)
   - Configure the necessary permissions
   - Save and install the app in your Intercom workspace

## API Endpoints

The following endpoints are available on the server:

- `POST /api/initialize` - Returns the initial canvas configuration
- `POST /api/submit` - Handles form submissions

## Customization

To customize the app:

1. Update the canvas configuration in `server/server.ts`
2. Modify the styling in `src/App.css`
3. Add new components and functionality as needed

## License

MIT
