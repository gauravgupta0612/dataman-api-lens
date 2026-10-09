Rails.application.routes.draw do
  root 'home#index'
  namespace :api do
    resources :articles, only: [:index, :show, :create] do
      resources :comments, only: [:index]
      member do
        post :publish
      end
    end
  end
  get '/about', to: 'pages#about'
end
