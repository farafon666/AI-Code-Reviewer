const HtmlWebpackPlugin = require('html-webpack-plugin');
const { ModuleFederationPlugin } = require('webpack').container;
const path = require('path');

module.exports = {
    entry: './src/index.ts',
    mode: 'development',
    // Отдельно открытый remote использует тот же backend и общие с host квоты review.
    devServer: {
        host: '127.0.0.1',
        port: 3001,
        proxy: {
            '/api': {
                target: 'http://127.0.0.1:5000',
                pathRewrite: { '^/api': '' },
                // Согласовано с host: прокси ждёт дольше общего дедлайна обработки на backend.
                proxyTimeout: 330000,
                onProxyReq(proxyReq, req, res) {
                    // После получения тела req.aborted не срабатывает: следим за закрытием ответа.
                    const onClose = () => {
                        if (!res.writableEnded) proxyReq.destroy();
                    };
                    res.once('close', onClose);
                    proxyReq.once('close', () => res.removeListener('close', onClose));
                    if (res.destroyed) onClose();
                },
            },
        },
    },
    output: {
        publicPath: 'auto',
    },
    resolve: {
        extensions: ['.tsx', '.ts', '.js'],
    },
    module: {
        rules: [
            {
                test: /\.tsx?$/,
                loader: 'ts-loader',
                exclude: /node_modules/,
            },
            {
                test: /\.css$/,
                use: ['style-loader', 'css-loader'],
            },
        ],
    },
    plugins: [
        new ModuleFederationPlugin({
            name: 'remote',
            filename: 'remoteEntry.js',
            exposes: {
                './CodeReviewer': './src/CodeReviewer',
            },
            shared: {
                react: { singleton: true, eager: true },
                'react-dom': { singleton: true, eager: true },
            },
        }),
        new HtmlWebpackPlugin({
            template: './public/index.html',
        }),
    ],
};
