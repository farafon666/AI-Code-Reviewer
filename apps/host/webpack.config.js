const HtmlWebpackPlugin = require('html-webpack-plugin');
const { ModuleFederationPlugin } = require('webpack').container;
const path = require('path');

module.exports = {
    entry: './src/index.ts',
    mode: 'development',
    // Dev server доступен только локально; API проксируется с того же origin без открытого CORS.
    devServer: {
        host: '127.0.0.1',
        port: 3000,
        historyApiFallback: true,
        proxy: {
            '/api': {
                target: 'http://127.0.0.1:5000',
                pathRewrite: { '^/api': '' },
                // Запас относительно 300-секундного дедлайна review нужен для получения JSON-ошибки.
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
            '/remote': {
                target: 'http://127.0.0.1:3001',
                pathRewrite: { '^/remote': '' },
            },
        },
    },
    output: {
        publicPath: 'auto',
        // Новый код получает новый URL, в том числе при загрузке remote через host.
        filename: '[name].[contenthash].js',
        chunkFilename: '[name].[contenthash].js',
        clean: true,
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
                options: {
                    configFile: path.resolve(__dirname, 'tsconfig.json'),
                },
            },
            {
                test: /\.css$/,
                use: ['style-loader', 'css-loader'],
            },
        ],
    },
    plugins: [
        new ModuleFederationPlugin({
            name: 'host',
            remotes: {
                remote: 'remote@/remote/remoteEntry.js',
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
