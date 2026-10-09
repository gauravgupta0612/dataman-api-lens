from rest_framework import viewsets, serializers
from rest_framework.decorators import action
from django.views import View

class PostSerializer(serializers.ModelSerializer):
    title = serializers.CharField()
    body = serializers.CharField(required=False)

class PostViewSet(viewsets.ModelViewSet):
    serializer_class = PostSerializer

    @action(detail=True, methods=['post'])
    def publish(self, request, pk=None):
        pass

def year_archive(request, year):
    sort = request.GET.get('sort')

class CommentView(View):
    def get(self, request):
        pass
    def post(self, request):
        text = request.POST.get('text')
