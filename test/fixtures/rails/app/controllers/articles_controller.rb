class ArticlesController < ApplicationController
  def index
    @articles = Article.where(tag: params[:tag])
  end
  def create
    Article.create(article_params)
  end
  private
  def article_params
    params.require(:article).permit(:title, :body)
  end
end
